import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import {defineConfig} from 'vite';

// With PULSE_API set (npm run dev:site), the website runs on its own and sends API calls to that gateway,
// so the site can be previewed without a local database or secrets.
const api = process.env.PULSE_API;
const toApi = {target: api, changeOrigin: true, secure: true};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: api ? {proxy: {'/api': toApi, '/mcp': toApi, '/.well-known': toApi, '/llms.txt': toApi}} : undefined,
});
