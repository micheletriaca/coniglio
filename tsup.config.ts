import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  outDir: 'lib',
  sourcemap: true,
  cjsInterop: true,
  target: 'esnext',
  clean: true,
  outExtension ({ format }) {
    if (format === 'cjs') {
      return { js: '.cjs' }
    }
    if (format === 'esm') {
      return { js: '.esm.js' }
    }
    return {}
  }
})
