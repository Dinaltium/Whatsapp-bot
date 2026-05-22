const { join } = require("path");

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  // Changes the cache location for Puppeteer to be within node_modules so it is cached by Render.
  cacheDirectory: join(__dirname, "node_modules", ".cache", "puppeteer"),
};
