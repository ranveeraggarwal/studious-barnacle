import { defineConfig } from 'vitest/config';

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    exclude: ['node_modules', 'dist', '.agents', 'tests/e2e/**'],
    environment: 'node',
    globals: false,
  },
});
