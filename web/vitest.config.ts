import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/core/**/*.test.ts', 'test/worker/**/*.test.ts', 'test/services/**/*.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
  },
});
