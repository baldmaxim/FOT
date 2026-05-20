import { vi } from 'vitest';

// Тестовый bootstrap: гарантирует обязательные env-переменные ДО импорта src/config/env.ts.
// На машине разработчика .env подхватывается dotenv (override:true) и перекрывает эти заглушки.
// В чистом окружении (CI / sandbox без .env) заглушки не дают env.ts вызвать process.exit(1).
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.JWT_SECRET ||= 'test-jwt-secret-must-be-long-enough-for-zod-validator';
process.env.NODE_ENV ||= 'test';
process.env.SIGUR_RUNTIME_ALLOWED_HOSTS ||= '*';
process.env.DATABASE_URL ||= 'postgres://test:test@localhost.test:5432/test';
process.env.DATABASE_POOL_MAX ||= '10';
process.env.DATABASE_STATEMENT_TIMEOUT_MS ||= '30000';
process.env.DATABASE_SSL ||= 'false';
// Гарантируем, что Sentry молчит в тестах (DSN не задан → init не вызывается).
delete process.env.SENTRY_DSN;

// Полный мок @sentry/node — иначе при импорте instrument.ts/app.ts vitest подтянет настоящий SDK
// с OpenTelemetry-патчами и попытками сетевых запросов в тестах.
vi.mock('@sentry/node', () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  captureCheckIn: vi.fn(() => 'mock-check-in-id'),
  addBreadcrumb: vi.fn(),
  setupExpressErrorHandler: vi.fn(),
  getCurrentScope: () => ({ setUser: vi.fn(), setTag: vi.fn(), setContext: vi.fn() }),
  setUser: vi.fn(),
  setTag: vi.fn(),
  setContext: vi.fn(),
}));

vi.mock('@sentry/profiling-node', () => ({
  nodeProfilingIntegration: () => ({ name: 'NodeProfiling' }),
}));
