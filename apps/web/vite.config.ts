import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  build: { target: 'es2022', sourcemap: 'hidden' },
  // sqlite-wasm resolves its .wasm relative to itself; pre-bundling would break that.
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
  worker: { format: 'es' },
  server: { proxy: { '/api': 'http://localhost:8787' } },
})
