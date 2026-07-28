import { defineConfig } from 'oxfmt'

const config = defineConfig({
  ignorePatterns: ['node_modules/**', 'lib/**', 'coverage/**'],
  semi: false,
  trailingComma: 'all',
  singleQuote: true,
  useTabs: false,
})

export default config
