import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    exclude: ["test/**/*.live.test.ts"],
    coverage: { provider: "v8", include: ["src"], exclude: ["src/**/*.test.ts"] },
  },
});
