import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ["**/*-test.ts", "**/*-test.js", "**/*.test.ts", "**/*.test.js"],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/**',
        'dist/**',
        '**/*.test.ts',
        '**/*.config.*',
        'scripts/**',
      ],
    },
  },
  resolve: {
    alias: {
      '@': new URL('./', import.meta.url).pathname,
      '@/lib': new URL('./lib/', import.meta.url).pathname,
    },
  },
});