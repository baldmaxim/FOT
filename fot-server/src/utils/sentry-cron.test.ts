import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Sentry from '@sentry/node';

import { runWithCronMonitor } from './sentry-cron.js';

describe('runWithCronMonitor — env whitelist', () => {
  const captureCheckIn = vi.mocked(Sentry.captureCheckIn);

  beforeEach(() => {
    captureCheckIn.mockClear();
    process.env.SENTRY_DSN = 'https://test@sentry.example/1';
  });

  afterEach(() => {
    delete process.env.SENTRY_DSN;
    delete process.env.SENTRY_CRON_MONITOR_SLUGS;
  });

  it('SENTRY_CRON_MONITOR_SLUGS не задан → checkin не отправляется, fn вызывается', async () => {
    delete process.env.SENTRY_CRON_MONITOR_SLUGS;
    const fn = vi.fn(async () => {});

    await runWithCronMonitor('presence-polling', fn, {
      schedule: { type: 'interval', value: 1, unit: 'minute' },
    });

    expect(fn).toHaveBeenCalledTimes(1);
    expect(captureCheckIn).not.toHaveBeenCalled();
  });

  it('slug в whitelist → checkin отправляется дважды (in_progress + ok)', async () => {
    process.env.SENTRY_CRON_MONITOR_SLUGS = 'foo,presence-polling,bar';
    const fn = vi.fn(async () => {});

    await runWithCronMonitor('presence-polling', fn, {
      schedule: { type: 'interval', value: 1, unit: 'minute' },
    });

    expect(fn).toHaveBeenCalledTimes(1);
    expect(captureCheckIn).toHaveBeenCalledTimes(2);
    expect(captureCheckIn.mock.calls[0][0]).toMatchObject({
      monitorSlug: 'presence-polling',
      status: 'in_progress',
    });
    expect(captureCheckIn.mock.calls[1][0]).toMatchObject({
      monitorSlug: 'presence-polling',
      status: 'ok',
    });
  });

  it('slug не в whitelist → checkin не отправляется, fn вызывается', async () => {
    process.env.SENTRY_CRON_MONITOR_SLUGS = 'presence-polling';
    const fn = vi.fn(async () => {});

    await runWithCronMonitor('sigur-monitor', fn, {
      schedule: { type: 'interval', value: 1, unit: 'minute' },
    });

    expect(fn).toHaveBeenCalledTimes(1);
    expect(captureCheckIn).not.toHaveBeenCalled();
  });

  it('пустая SENTRY_CRON_MONITOR_SLUGS → checkin не отправляется', async () => {
    process.env.SENTRY_CRON_MONITOR_SLUGS = '';
    const fn = vi.fn(async () => {});

    await runWithCronMonitor('presence-polling', fn, {
      schedule: { type: 'interval', value: 1, unit: 'minute' },
    });

    expect(captureCheckIn).not.toHaveBeenCalled();
  });

  it('пробелы и пустые элементы в whitelist игнорируются', async () => {
    process.env.SENTRY_CRON_MONITOR_SLUGS = '  presence-polling  ,  , ,';
    const fn = vi.fn(async () => {});

    await runWithCronMonitor('presence-polling', fn, {
      schedule: { type: 'interval', value: 1, unit: 'minute' },
    });

    expect(captureCheckIn).toHaveBeenCalledTimes(2);
  });
});
