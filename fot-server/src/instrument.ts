// ВАЖНО: этот файл должен импортироваться ПЕРВЫМ в src/index.ts —
// до любых import express/http/socket.io. Sentry для Node использует
// OpenTelemetry-инструментирование, патчит модули при загрузке.
import { config } from 'dotenv';
config({ override: true });

import * as Sentry from '@sentry/node';
import { nodeProfilingIntegration } from '@sentry/profiling-node';

const dsn = process.env.SENTRY_DSN;

if (dsn && process.env.NODE_ENV === 'production') {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? 'development',
    release: process.env.SENTRY_RELEASE,
    integrations: [nodeProfilingIntegration()],
    tracesSampleRate: 0.1,
    profilesSampleRate: 0.1,
    sendDefaultPii: false,
  });
}

export { Sentry };
