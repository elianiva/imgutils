import { defineConfig } from 'vite'

export default defineConfig({
  // The codec glue resolves its .wasm file with `new URL(..., import.meta.url)`,
  // which the dependency pre-bundler cannot rewrite.
  optimizeDeps: {
    exclude: ['@jsquash/jpeg', '@jsquash/png', '@jsquash/resize', '@jsquash/webp'],
  },
})
