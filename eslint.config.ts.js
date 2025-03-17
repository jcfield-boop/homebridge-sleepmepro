import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    files: ['src/temp/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
  }
);