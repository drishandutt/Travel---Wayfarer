import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': `http://localhost:${process.env.WAYFARER_API_PORT ?? 8787}` }, // Claude lives on the API server
  },
  worker: { format: 'es' }, // MapLibre spawns its worker as a module worker
})
