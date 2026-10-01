import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests", workers: 1, timeout: 60000,
  use: { baseURL: "http://127.0.0.1:8090", browserName: "chromium" },
  webServer: [
    { command: "node reference.mjs", url: "http://127.0.0.1:3001/health", ignoreHTTPSErrors: false, reuseExistingServer: false },
    { command: "../../packages/python/.venv/bin/python server.py --server http://127.0.0.1:3001/mcp", url: "http://127.0.0.1:8090", reuseExistingServer: false },
  ],
});
