import { resolve } from 'node:path'
import { defineConfig } from 'vite'

// The site and the console. The proxy serves the built console from its own
// origin, so in development /api and /mcp go to a running `pnpm demo`.
export default defineConfig({
  base: process.env.BASE ?? '/',
  server: {
    port: 5183,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:7325' },
  },
  build: {
    target: 'es2023',
    rollupOptions: { input: { site: resolve(import.meta.dirname, 'index.html'), console: resolve(import.meta.dirname, 'console.html') } },
  },
})
