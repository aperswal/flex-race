import { existsSync } from "node:fs";
import { defineConfig } from "vitest/config";

// Reads OPENAI_API_KEY from a local, git-ignored .env when one exists (Node's built-in loader).
if (existsSync(".env")) process.loadEnvFile(".env");

export default defineConfig({
  test: { include: ["test/**/*.live.test.ts"], testTimeout: 180_000 },
});
