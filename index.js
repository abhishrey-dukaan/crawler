import express from "express";
import puppeteer from "puppeteer";
import * as cheerio from "cheerio";
import axios from "axios";
import logger from "./utils/logger.js";
import FormData from "form-data";

const app = express();
const port = 4001;

// Enable keep-alive and set timeouts
app.use((req, res, next) => {
  res.set("Connection", "keep-alive");
  res.set("Keep-Alive", "timeout=120");
  next();
});

// Increase server timeout
app.use((req, res, next) => {
  req.setTimeout(300000); // 5 minutes
  res.setTimeout(300000); // 5 minutes
  next();
});

// Constants
const DMS_UPLOAD_URL = "https://dms.mydukaan.io/api/media/upload/";
const VIEWPORT = {
  width: 1920,
  height: 1080,
  deviceScaleFactor: 1,
};

// Helper function for delay
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Validate URL middleware
const validateUrl = (req, res, next) => {
  let { url } = req.query;
  if (!url) {
    return res.status(400).json({ error: "URL parameter is required" });
  }

  // Format URL if protocol is missing
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = `https://${url}`;
    req.query.url = url; // Update the request query with formatted URL
  }

  try {
    new URL(url);
    next();
  } catch (error) {
    return res.status(400).json({ error: "Invalid URL format" });
  }
};

const launchBrowser = async () => {
  const maxRetries = 3;
  let retryCount = 0;

  while (retryCount < maxRetries) {
    try {
      return await puppeteer.launch({
        headless: "new",
        timeout: 120000,
        pipe: false,
        dumpio: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-accelerated-2d-canvas",
          "--disable-gpu",
          "--window-size=1920,1080",
          "--disable-web-security",
          "--disable-features=IsolateOrigins,site-per-process",
          "--no-zygote",
          "--single-process",
          "--no-first-run",
          "--disable-infobars",
          "--disable-notifications",
          "--disable-extensions",
          "--disable-sync",
          "--no-default-browser-check",
          "--ignore-certificate-errors",
          "--ignore-certificate-errors-spki-list",
          "--force-color-profile=srgb",
        ],
        defaultViewport: VIEWPORT,
      });
    } catch (error) {
      retryCount++;
      logger.error(
        `Browser launch attempt ${retryCount} failed: ${error.message}`
      );
      if (retryCount === maxRetries) throw error;
      await delay(2000 * retryCount);
    }
  }
};

// Screenshot endpoint
app.get("/screenshot", validateUrl, async (req, res) => {
  const { url } = req.query;
  logger.info(`Screenshot request received for URL: ${url}`);
  let browser;

  try {
    browser = await launchBrowser();

    const page = await browser.newPage();

    // Set longer default timeout
    page.setDefaultTimeout(60000);
    page.setDefaultNavigationTimeout(60000);

    // Set user agent
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    await page.setViewport(VIEWPORT);

    try {
      // First attempt with networkidle0
      await page.goto(url, {
        waitUntil: "networkidle0",
        timeout: 60000,
      });
    } catch (navigationError) {
      logger.warn(
        `Initial navigation attempt failed: ${navigationError.message}. Retrying with domcontentloaded...`
      );
      // If first attempt fails, retry with just domcontentloaded
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
    }

    // Wait for React/JS content with increased timeout
    try {
      await page.waitForFunction(
        () => {
          const ready = document.readyState === "complete";
          const reactRoot = document.querySelector("[data-reactroot]");
          const root = document.querySelector("#root");
          const app = document.querySelector("#app");

          return (
            ready &&
            (!reactRoot || !reactRoot.hasAttribute("aria-busy")) &&
            (!root || !root.hasAttribute("aria-busy")) &&
            (!app || !app.hasAttribute("aria-busy"))
          );
        },
        { timeout: 20000 }
      );
    } catch (waitError) {
      logger.warn(
        `Wait for React content timed out: ${waitError.message}. Proceeding with screenshot...`
      );
    }

    // Scroll to trigger viewport animations
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
      window.scrollTo(0, 0);
    });
    await delay(1000); // Wait for animations to complete

    const screenshot = await page.screenshot({
      fullPage: true,
      type: "png",
    });

    await browser.close();

    // Create form data for DMS upload
    const formData = new FormData();
    formData.append("file", screenshot, {
      filename: `screenshot-${Date.now()}.png`,
      contentType: "image/png",
    });

    // Upload to DMS
    const uploadResponse = await axios.post(DMS_UPLOAD_URL, formData, {
      headers: {
        ...formData.getHeaders(),
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        Accept: "application/json",
        Referer: "https://web.mydukaan.io/",
        "x-Mode": "seller-web",
        "sec-ch-ua-platform": "macOS",
      },
    });

    res.status(uploadResponse.status).json(uploadResponse.data);
    logger.info(
      `Screenshot captured and uploaded successfully for URL: ${url}`
    );
  } catch (error) {
    logger.error(
      `Error processing screenshot for URL ${url}: ${error.message}`
    );
    if (error.response) {
      logger.error("DMS Error Response:", error.response.data);
      res.status(error.response.status).json(error.response.data);
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// Scrape endpoint
app.get("/scrape", validateUrl, async (req, res) => {
  const { url } = req.query;
  logger.info(`Scrape request received for URL: ${url}`);
  let browser;
  let page;

  const cleanup = async () => {
    try {
      if (page) {
        await page
          .close()
          .catch((err) => logger.error(`Error closing page: ${err.message}`));
      }
      if (browser) {
        await browser
          .close()
          .catch((err) =>
            logger.error(`Error closing browser: ${err.message}`)
          );
      }
    } catch (err) {
      logger.error(`Error during cleanup: ${err.message}`);
    }
  };

  try {
    browser = await launchBrowser();
    page = await browser.newPage();

    // Set up error handlers before any navigation
    page.on("error", (err) => {
      logger.error(`Page error: ${err.message}`);
      cleanup();
    });

    page.on("pageerror", (err) => {
      logger.error(`Page error: ${err.message}`);
    });

    // Handle crashed targets
    browser.on("targetcrashed", async (target) => {
      logger.error("Target crashed:", target.url());
      await cleanup();
      throw new Error("Browser target crashed");
    });

    // Handle disconnected browser
    browser.on("disconnected", async () => {
      logger.error("Browser disconnected");
      await cleanup();
      throw new Error("Browser disconnected");
    });

    // Set longer default timeout
    page.setDefaultTimeout(120000);
    page.setDefaultNavigationTimeout(120000);

    // Block unnecessary resources to speed up loading
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      const resourceType = request.resourceType();
      if (
        resourceType === "image" ||
        resourceType === "font" ||
        resourceType === "media"
      ) {
        request.abort();
      } else {
        request.continue();
      }
    });

    // Set viewport
    await page.setViewport(VIEWPORT);

    // Set user agent
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    try {
      // First attempt with networkidle0
      await page.goto(url, {
        waitUntil: "networkidle0",
        timeout: 60000,
      });
    } catch (navigationError) {
      logger.warn(
        `Initial navigation attempt failed: ${navigationError.message}. Retrying with domcontentloaded...`
      );
      // If first attempt fails, retry with just domcontentloaded
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
    }

    // Wait for React/JS content with increased timeout
    try {
      await page.waitForFunction(
        () => {
          const ready = document.readyState === "complete";
          const reactRoot = document.querySelector("[data-reactroot]");
          const root = document.querySelector("#root");
          const app = document.querySelector("#app");

          return (
            ready &&
            (!reactRoot || !reactRoot.hasAttribute("aria-busy")) &&
            (!root || !root.hasAttribute("aria-busy")) &&
            (!app || !app.hasAttribute("aria-busy"))
          );
        },
        { timeout: 20000 }
      );
    } catch (waitError) {
      logger.warn(
        `Wait for React content timed out: ${waitError.message}. Proceeding with scraping...`
      );
    }

    // Scroll to trigger viewport animations
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
      window.scrollTo(0, 0);
    });
    await delay(1000); // Wait for animations to complete

    const scrapedData = await page.evaluate(() => {
      const getData = () => {
        // Helper function to safely get text content
        const safeTextContent = (element) =>
          element ? element.textContent.trim() : "";

        // Get all headings, including those rendered by React
        const headings = {
          h1: Array.from(document.querySelectorAll("h1")).map((h) =>
            safeTextContent(h)
          ),
          h2: Array.from(document.querySelectorAll("h2")).map((h) =>
            safeTextContent(h)
          ),
          h3: Array.from(document.querySelectorAll("h3")).map((h) =>
            safeTextContent(h)
          ),
        };

        // Get all links, including those added by React
        const links = Array.from(document.querySelectorAll("a")).map((a) =>
          safeTextContent(a)
        );

        // Get all images
        const images = Array.from(document.querySelectorAll("img")).map(
          (img) => {
            return {
              src: img.src,
              alt: img.alt || "",
              title: img.title || "",
              width: img.width || null,
              height: img.height || null,
            };
          }
        );

        // Get meta tags
        const metaTags = {
          title: document.title,
          description: document.querySelector('meta[name="description"]')
            ?.content,
          ogTitle: document.querySelector('meta[property="og:title"]')?.content,
          ogDescription: document.querySelector(
            'meta[property="og:description"]'
          )?.content,
        };

        // Get main content
        const mainContent = Array.from(
          document.querySelectorAll('main, #root, #app, [role="main"]')
        )
          .map((el) => safeTextContent(el))
          .filter((text) => text.length > 0);

        return {
          headings,
          links,
          images,
          metaTags,
          mainContent,
        };
      };

      return getData();
    });

    await browser.close();

    res.json({
      url,
      data: scrapedData,
    });

    logger.info(`Scraping completed successfully for URL: ${url}`);
  } catch (error) {
    logger.error(`Error scraping URL ${url}: ${error.message}`);
    await cleanup();
    res.status(500).json({
      error: error.message,
      code: error.code || "UNKNOWN_ERROR",
      url: url,
    });
  }
});

// Error handling middleware with detailed logging
app.use((err, req, res, next) => {
  logger.error(`Unhandled error: ${err.message}`);
  logger.error(`Stack trace: ${err.stack}`);
  res.status(500).json({
    error: "Internal server error",
    message: err.message,
    path: req.path,
    method: req.method,
  });
});

// Graceful shutdown handling
process.on("SIGTERM", () => {
  logger.info("SIGTERM signal received: closing HTTP server");
  server.close(() => {
    logger.info("HTTP server closed");
    process.exit(0);
  });
});

const server = app.listen(port, () => {
  logger.info(`Server running at http://localhost:${port}`);
});

// Set server timeouts
server.keepAliveTimeout = 120000; // 2 minutes
server.headersTimeout = 120000; // 2 minutes
