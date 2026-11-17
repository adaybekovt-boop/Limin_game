import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const v = (f) => fileURLToPath(new URL(`./vendor/three/${f}`, import.meta.url));

export default defineConfig({
  base: './',
  resolve: {
    // three.js r187 (WebGPU build) is vendored; map the bare imports onto it.
    alias: [
      { find: /^three\/webgpu$/, replacement: v('three.webgpu.js') },
      { find: /^three\/tsl$/, replacement: v('three.tsl.js') },
      { find: /^three$/, replacement: v('three.webgpu.js') },
    ],
  },
  server: { port: 5173, open: true },
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
    modulePreload: { polyfill: false },
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        // three changes rarely: keep it in its own long-cached chunk
        manualChunks: (id) => (id.includes('/vendor/three/') ? 'three' : undefined),
      },
    },
  },
});
