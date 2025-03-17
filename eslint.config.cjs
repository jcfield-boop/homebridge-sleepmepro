const eslintRecommended = require('eslint/conf/eslint-recommended');
const tsRecommended = require('@typescript-eslint/eslint-plugin/dist/configs/recommended');

module.exports = [
  {
    files: ['src/temp/**/*.ts'],
    languageOptions: {
      parser: require('@typescript-eslint/parser'),
    },
    plugins: {
      '@typescript-eslint': require('@typescript-eslint/eslint-plugin'),
    },
    ...eslintRecommended,
    ...tsRecommended,
  },
];