import { defineConfig } from "vitest/config";

// Tests run in Node with an in-process fake GitHub API: the Worker code only
// uses web-standard APIs (fetch, Request, crypto.subtle), so no network or
// real token is needed. `wrangler dev` is used separately for runtime checks.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "test/**/*.test.mjs"],
    environment: "node",
    testTimeout: 20_000,
  },
});
