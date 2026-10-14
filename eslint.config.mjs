import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Capacitor/Gradle build output (generated, not our source).
    "android/**",
  ]),
  {
    // Landing-page marketing copy (src/content/marketing) is fictional demo
    // content. It must never reach a clinical, portal or API path: only the
    // landing components may import it.
    files: ["src/app/**", "src/lib/**", "src/components/**"],
    ignores: ["src/components/landing/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/content/marketing", "@/content/marketing/*", "**/content/marketing", "**/content/marketing/*"],
              message: "Marketing demo content is for src/components/landing only; never use it as patient or app data.",
            },
          ],
        },
      ],
    },
  },
  {
    // Allow the conventional `_name` marker for deliberately unused params.
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
]);

export default eslintConfig;
