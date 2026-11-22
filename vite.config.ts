import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Two build targets:
//   `vite build`            -> dist/  (one self-contained index.html, works from file://)
//   `vite build --mode dev` -> dist-dev/ (normal, served by `vite dev`)
export default defineConfig(({ command }) => ({
  base: './',
  plugins: command === 'build' ? [viteSingleFile({ removeViteModuleLoader: true })] : [],
  worker: { format: 'iife' },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    sourcemap: false,
  },
  server: { port: 5199, strictPort: false },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    testTimeout: 60_000,
  },
}));
