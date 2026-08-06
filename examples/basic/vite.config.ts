import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

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
  build: {
    outDir: path.resolve(import.meta.dirname, '../../dist-example'),
    emptyOutDir: true,
  },
})
