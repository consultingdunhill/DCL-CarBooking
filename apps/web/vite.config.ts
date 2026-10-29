import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  // VITE_* variables live in the repo-root .env, shared with the API.
  envDir: '../..',
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      injectRegister: false,
      devOptions: { enabled: false },
      manifest: {
        name: 'Fleet – Company Car Booking',
        short_name: 'Fleet',
        description: 'Book company cars, run trips and see what they cost.',
        theme_color: '#0f5e57',
        background_color: '#f7f7f5',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: '/icon-maskable.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
          // PNG copies of the SVGs: Android's installed app (WebAPK) and some browsers need raster icons.
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      injectManifest: { globPatterns: ['**/*.{js,css,html,svg,png,woff2}'] },
    }),
  ],
  server: { port: 5173, host: true },
  // `pnpm share` builds with VITE_API_URL=/api; pass those calls on to the local API.
  preview: { port: 4173, proxy: { '/api': { target: 'http://localhost:4000', rewrite: (p) => p.replace(/^\/api/, '') } } },
  build: { sourcemap: true, chunkSizeWarningLimit: 1200 },
});
