import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The stub tests compile MineVibe.swift once (about 6 s) and drive real processes.
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
