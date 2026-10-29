import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser", timeout: 20_000, workers: 1,
  use: { baseURL: "http://127.0.0.1:4320", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, trace: "retain-on-failure" },
  webServer: { command: "pnpm --filter @codexphone/web exec vite preview --host 127.0.0.1 --port 4320 --strictPort", url: "http://127.0.0.1:4320", reuseExistingServer: true },
});
