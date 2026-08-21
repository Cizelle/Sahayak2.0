/* Flat-config-free ESLint for portability. TypeScript-only; native Kotlin is
 * linted by ktlint/Android Studio, not ESLint. */
module.exports = {
	root: true,
	parser: "@typescript-eslint/parser",
	parserOptions: { ecmaVersion: 2022, sourceType: "module" },
	plugins: ["@typescript-eslint"],
	extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
	env: { node: true, es2022: true },
	ignorePatterns: ["dist/", "build/", "node_modules/", "**/android/**", "**/ios/**", "**/*.kt"],
	rules: {
		"@typescript-eslint/no-explicit-any": "off",
		"@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
	},
};
