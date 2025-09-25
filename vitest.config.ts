import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ["tests/**/*-test.ts", "tests/**/*-test.js", "tests/**/*.test.ts", "tests/**/*.test.js"],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/**',
        'dist/**',
        'tests/**',
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