import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "coverage/", "node_modules/"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      "@typescript-eslint/explicit-module-boundary-types": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "no-console": "error",
    },
  },
  { files: ["eslint.config.js"], ...tseslint.configs.disableTypeChecked },
);
