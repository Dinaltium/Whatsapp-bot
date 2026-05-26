import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    env: {
      REDIS_URL: "redis://127.0.0.1:6379",
    },
  },
});
