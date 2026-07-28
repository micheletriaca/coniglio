import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: 'src/index.ts',
  format: ['esm', 'cjs'],
  dts: true,
  outDir: 'lib',
  sourcemap: true,
  deps: {
    neverBundle: true,
  },
  outputOptions: {
    exports: 'named',
  },
})
