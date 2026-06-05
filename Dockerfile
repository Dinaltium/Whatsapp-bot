# Use a lightweight Debian-based Node image
FROM node:24-bookworm-slim

# Update system and install minimal dependencies (ffmpeg for WhatsApp voice, ca-certificates for APIs)
# We run this BEFORE copying our code so Docker can cache this layer forever!
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    ca-certificates \
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
