import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')) as { version: string };

// Multi-page app: console (index.html) + floating widget (widget.html).
// The Node/WebSocket server (ws://127.0.0.1:9000/ws) is NOT part of this project.
export default defineConfig({
  root: __dirname,
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        console: resolve(__dirname, 'index.html'),
        widget: resolve(__dirname, 'widget.html'),
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
  },
});
