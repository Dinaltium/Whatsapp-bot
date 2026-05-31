const { join } = require("path");

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  // On the server, PUPPETEER_EXECUTABLE_PATH points to system Chromium
  // installed by nixpacks (apt chromium), skipping the ~300MB Chrome download.
  // Locally (no env var set), Puppeteer falls back to its own managed Chrome.
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,

  // Cache directory for local development — irrelevant when executablePath is set.
  cacheDirectory: join(__dirname, "node_modules", ".cache", "puppeteer"),
};
