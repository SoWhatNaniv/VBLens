import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Builds a single self-contained index.html (code, styles, worker, fonts inlined)
// so the decompiler can be opened offline straight from disk.
export default defineConfig({
  plugins: [react(), viteSingleFile({ removeViteModuleLoader: true })],
  worker: { format: 'iife' },
  build: { target: 'es2022', assetsInlineLimit: 100_000_000, chunkSizeWarningLimit: 100_000, cssCodeSplit: false },
});
