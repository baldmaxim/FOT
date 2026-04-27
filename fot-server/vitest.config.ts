import { defineConfig } from 'vitest/config';

// Тесты предполагают локальную таймзону Europe/Moscow (parseStoredEventTimestamp
// и formatLocalDateTime используют Date.getHours()). Прописываем TZ в env пула,
// чтобы прогон не зависел от TZ хоста.
process.env.TZ = process.env.TZ || 'Europe/Moscow';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 10000,
    setupFiles: ['./src/__tests__/setup.ts'],
    env: {
      TZ: process.env.TZ,
    },
  },
});
