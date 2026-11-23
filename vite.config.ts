import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// SLF terrain tiles send no CORS headers. The dev/preview server proxies them;
// a plain static build needs a user-supplied CORS proxy prefix (see README).
const proxy = {
  '/proxy/slf-map': {
    target: 'https://map.slf.ch',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/proxy\/slf-map/, ''),
  },
};

export default defineConfig({
  base: './',
  plugins: [viteSingleFile()],
  server: { proxy },
  preview: { proxy },
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
});
