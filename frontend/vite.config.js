import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.js'],
    globals: true,
  },
  server: {
    // Bind to 0.0.0.0 so Vite is reachable from outside the Docker container
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      // /api/* -> FastAPI backend (rewrite strips /api prefix)
      // API_URL is set to http://backend:8000 inside Docker,
      // falls back to localhost for running outside Docker.
      '/api': {
        target: process.env.API_URL ?? 'http://localhost:8000',
        changeOrigin: true
      },
    },
  },
})
