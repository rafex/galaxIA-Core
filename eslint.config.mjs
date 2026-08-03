import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // vendor/**: subtrees de repos externos (galaxIA-satellite-star,
    // galaxia-parser-catalog, DEC-0077) — cada uno tiene su propio lint,
    // no forman parte de los workspaces de este monorepo.
    ignores: ["**/dist/**", "**/node_modules/**", "**/version.json", "vendor/**", "**/assembly/**"],
  },
  {
    extends: [
      ...tseslint.configs.recommendedTypeChecked,
    ],
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // `any` está prohibido: usar `unknown` + type guard, o el tipo real,
      // en su lugar (ver CONTRIBUTING.md).
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      // Previene el bug de una promesa disparada sin `await`/`.catch`/`void`
      // que silenciosamente traga su error (mismo tipo de bug real que
      // motivó el fix de content-clearing en Nova, DEC-0056).
      "@typescript-eslint/no-floating-promises": "error",
      "no-console": ["off"],
    },
  },
  {
    // FhsNode se tipifica como `any` por el conflicto documentado entre
    // @libp2p/interface@^2 (floodsub/gossipsub pre-3.x) y @libp2p/interface@^3
    // (libp2p@3.x). Se relajan las reglas no-unsafe-* en los paquetes que usan
    // @rafex/galaxia-fhs-node (que re-exporta FhsNode = any).
    files: ["packages/fhs-node/**/*.ts", "apps/atlas/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-call": "off",
    },
  },
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    ...tseslint.configs.disableTypeChecked,
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
);
