import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'backup/**',
      'coverage/**',
      'dist/**',
      'node_modules/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs', '**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        Buffer: 'readonly',
        clearTimeout: 'readonly',
        console: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
      },
    },
    rules: {
      'brace-style': ['error'],
      'comma-dangle': ['error', 'always-multiline'],
      'curly': ['error', 'all'],
      'dot-notation': 'error',
      'eqeqeq': ['error', 'smart'],
      'indent': ['error', 2, { SwitchCase: 1 }],
      'linebreak-style': ['error', 'unix'],
      'max-len': ['warn', 160],
      'no-use-before-define': 'off',
      'object-curly-spacing': ['error', 'always'],
      'prefer-arrow-callback': 'warn',
      'quotes': ['error', 'single'],
      'semi': ['error', 'always'],
      '@typescript-eslint/no-use-before-define': ['error', {
        classes: false,
        enums: false,
        functions: false,
        typedefs: false,
      }],
      '@typescript-eslint/no-unused-vars': ['error', { caughtErrors: 'none' }],
    },
  },
);
