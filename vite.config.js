import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    open: false,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 4096,
  },
  // Rapier ships an inlined (base64) wasm build so it needs no special handling,
  // but pre-bundling it keeps the dev-server reload fast.
  optimizeDeps: {
    include: ['three', '@dimforge/rapier3d-compat'],
  },
});
