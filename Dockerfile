# Use a lightweight Debian-based Node image
FROM node:24-bookworm-slim

# Set environment variables for Puppeteer to skip downloading its own browser
# and point to the system-installed Chromium instead.
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Update system and install Chromium + minimal dependencies
# We run this BEFORE copying our code so Docker can cache this massive layer forever!
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libgbm1 \
    libasound2 \
    libpangocairo-1.0-0 \
    libxss1 \
    libgtk-3-0 \
    libxshmfence1 \
    libglu1 \
    ca-certificates \
    fonts-liberation \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Set the working directory
WORKDIR /app

# Copy package files first and install dependencies
# This creates another cached layer so we don't reinstall NPM packages unless package.json changes
COPY package.json package-lock.json* ./
RUN npm ci

# Now copy the rest of the application code
COPY . .

# Build the TypeScript code
RUN npm run build

# Expose the health check port
EXPOSE 3000

# Start the bot
CMD ["npm", "start"]
