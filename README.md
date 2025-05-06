# Web Crawler Application

A Node.js-based web crawler application that provides screenshot and scraping capabilities through HTTP endpoints.

## Features

- Screenshot endpoint (`/screenshot`) - Captures full-page screenshots of websites
- Scrape endpoint (`/scrape`) - Extracts key information from websites including headings, links, and meta tags

## Prerequisites

- Node.js (v14 or higher)
- npm (Node Package Manager)

## Installation

1. Clone the repository or download the source code
2. Install dependencies:

```bash
npm install
```

## Usage

1. Start the server:

```bash
npm start
```

The server will run on `http://localhost:3000`

### Endpoints

#### 1. Screenshot Endpoint

```
GET /screenshot?url=https://example.com
```

- Returns a PNG image file of the full webpage
- The image will be downloaded automatically

#### 2. Scrape Endpoint

```
GET /scrape?url=https://example.com
```

Returns JSON data containing:

- Page headings (h1, h2, h3)
- All links on the page
- Meta tags (title, description, og:title, og:description)

### Example Response (Scrape Endpoint)

```json
{
  "url": "https://example.com",
  "data": {
    "headings": {
      "h1": ["Main Heading"],
      "h2": ["Subheading 1", "Subheading 2"],
      "h3": ["Section 1", "Section 2"]
    },
    "links": ["https://example.com/page1", "https://example.com/page2"],
    "metaTags": {
      "title": "Example Page",
      "description": "Page description",
      "ogTitle": "OG Title",
      "ogDescription": "OG Description"
    }
  }
}
```

## Error Handling

The application includes error handling for:

- Invalid URLs
- Network timeouts
- Server errors

All errors are logged to `error.log` and `combined.log` files.

## Logging

The application uses Winston for logging:

- Console output for all logs
- File-based logging:
  - `error.log`: Error-level logs
  - `combined.log`: All logs
# crawler
