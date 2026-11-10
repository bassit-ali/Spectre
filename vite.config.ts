import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: 'src/ui',
  base: './',
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'src/ui/index.html'),
        widget: resolve(__dirname, 'src/ui/widget.html'),
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
