const { defineConfig, globalIgnores } = require("eslint/config");

const globals = require("globals");
const typescriptEslint = require("@typescript-eslint/eslint-plugin");
const js = require("@eslint/js");

const { FlatCompat } = require("@eslint/eslintrc");

const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
  allConfig: js.configs.all,
});

module.exports = defineConfig([
  {
    languageOptions: {
      globals: {
        ...globals.browser,
      },

      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: {},
    },

    extends: compat.extends(
      "eslint:recommended",
      "plugin:prettier/recommended",
      "plugin:@typescript-eslint/eslint-recommended",
      "plugin:@typescript-eslint/recommended",
    ),

    plugins: {
      "@typescript-eslint": typescriptEslint,
    },

    rules: {
      indent: [
        "error",
        2,
        {
          SwitchCase: 1,
        },
      ],

      "linebreak-style": ["error", "unix"],
      "no-unused-vars": "off",

      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  globalIgnores([
    "dist/",
    "tmp/",
    "bower_components/",
    "node_modules/",
    "coverage/",
    "!**/.*",
    "**/.*/",
    "**/.eslintcache",
    "**/eslint.config.cjs",
    "**/.prettierrc",
  ]),
]);
