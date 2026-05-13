import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Patches BigInt.prototype.toJSON so JSON.stringify works on the
    // bigint values our DB layer now returns. Same side-effect that
    // server.ts / sync.ts import at startup.
    setupFiles: ["./src/bigint-json.ts"],
  },
});
