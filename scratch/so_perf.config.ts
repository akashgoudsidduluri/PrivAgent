import { defineConfig } from 'vitest/config';

/**
 * Bench-only config. Kept separate from vitest.config.ts so the performance
 * harness never joins the permanent correctness suite.
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['scratch/so_perf.test.ts'],
    testTimeout: 120000,
  },
});
