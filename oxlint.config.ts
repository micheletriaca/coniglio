import { defineConfig } from 'oxlint'

const config = defineConfig({
  plugins: ['typescript'],
  rules: {
    'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    'no-var': 'error',
    'prefer-const': 'error',
    'typescript/consistent-type-imports': 'error',
    'typescript/no-explicit-any': 'error',
  },
  ignorePatterns: ['node_modules/**', 'lib/**', 'coverage/**'],
})

export default config
