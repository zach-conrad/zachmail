import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  build: { target: 'es2022', sourcemap: 'hidden' },
  server: { proxy: { '/api': 'http://localhost:8787' } },
})
