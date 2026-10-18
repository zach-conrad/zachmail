import { defineConfig } from 'vite'

// The bridge is injected into the web view as an initialization script, so it ships as one
// self-contained IIFE that the Rust shell embeds with include_str!.
export default defineConfig({
  build: {
    lib: {
      entry: 'src/bridge.ts',
      formats: ['iife'],
      name: 'zachmailBridge',
      fileName: () => 'bridge.js',
    },
    target: 'safari16',
    outDir: 'dist',
    emptyOutDir: true,
  },
})
