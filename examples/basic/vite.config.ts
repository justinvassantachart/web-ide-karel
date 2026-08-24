import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const productionIsolationHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Content-Security-Policy': [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "script-src 'self' 'wasm-unsafe-eval' https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self' blob: https://cdn.jsdelivr.net https://runno.dev",
    "worker-src 'self' blob:",
  ].join('; '),
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
}

export default defineConfig({
  root: import.meta.dirname,
  base: './',
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: '@web-ide/karel/styles.css',
        replacement: path.resolve(import.meta.dirname, '../../dist/styles.css'),
      },
      {
        find: '@web-ide/karel',
        replacement: path.resolve(import.meta.dirname, '../../dist/index.js'),
      },
    ],
    dedupe: ['react', 'react-dom', 'web-ide', '@web-ide/karel'],
  },
  server: { headers: productionIsolationHeaders },
  preview: { headers: productionIsolationHeaders },
  build: {
    outDir: path.resolve(import.meta.dirname, '../../dist-example'),
    emptyOutDir: true,
  },
})
