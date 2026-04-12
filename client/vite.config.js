import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [
    react(),
    // Discord's activity proxy layer may strip CORS headers forwarded from our
    // Express server, causing the browser to block crossorigin-tagged assets.
    // Removing the attribute makes the browser treat them as same-origin fetches,
    // which always succeed inside the discordsays.com proxy frame.
    {
      name: 'remove-crossorigin',
      transformIndexHtml(html) {
        return html.replace(/ crossorigin/g, '');
      },
    },
  ],
  // Read .env from the project root (one level up from client/)
  envDir: '..',
  server: {
    port: 5173,
    allowedHosts: true,
    // HMR must be disabled — inside Discord the iframe origin is discordsays.com
    // and Vite's HMR WebSocket can't reach back to localhost, causing a blank page.
    hmr: false,
    // Proxy /api/* to the Express server during local development
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
        secure: false,
      },
      '/socket.io': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        ws: true,
        secure: false,
      },
      '/callback': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        secure: false,
      },
    },
  },
});
