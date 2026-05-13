import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { pgQuery, pgQueryOne, pgExecute, pgTx, mockedState } = vi.hoisted(() => ({
  pgQuery: vi.fn(),
  pgQueryOne: vi.fn(),
  pgExecute: vi.fn(),
  pgTx: vi.fn(),
  mockedState: {
    settingsRows: [] as Array<{ key: string; value: string | null }>,
  },
}));

vi.mock('../config/postgres.js', () => ({
  query: pgQuery,
  queryOne: pgQueryOne,
  execute: pgExecute,
  withTransaction: pgTx,
}));

import { settingsService } from './settings.service.js';

describe('settingsService Sigur connection resolution', () => {
  const originalEnv = {
    internalUrl: process.env.SIGUR_INTERNAL_URL,
    internalUsername: process.env.SIGUR_INTERNAL_USERNAME,
    internalPassword: process.env.SIGUR_INTERNAL_PASSWORD,
    externalUrl: process.env.SIGUR_EXTERNAL_URL,
    externalUsername: process.env.SIGUR_EXTERNAL_USERNAME,
    externalPassword: process.env.SIGUR_EXTERNAL_PASSWORD,
  };

  beforeEach(() => {
    pgQuery.mockReset();
    pgQueryOne.mockReset();
    pgExecute.mockReset();
    pgTx.mockReset();
    mockedState.settingsRows = [];
    // SELECT key, value FROM system_settings  →  pgQuery returns rows
    pgQuery.mockImplementation(async () => mockedState.settingsRows);
    settingsService.invalidateCache();
    process.env.SIGUR_INTERNAL_URL = undefined;
    process.env.SIGUR_INTERNAL_USERNAME = undefined;
    process.env.SIGUR_INTERNAL_PASSWORD = undefined;
    process.env.SIGUR_EXTERNAL_URL = undefined;
    process.env.SIGUR_EXTERNAL_USERNAME = undefined;
    process.env.SIGUR_EXTERNAL_PASSWORD = undefined;
  });

  afterEach(() => {
    settingsService.invalidateCache();
    process.env.SIGUR_INTERNAL_URL = originalEnv.internalUrl;
    process.env.SIGUR_INTERNAL_USERNAME = originalEnv.internalUsername;
    process.env.SIGUR_INTERNAL_PASSWORD = originalEnv.internalPassword;
    process.env.SIGUR_EXTERNAL_URL = originalEnv.externalUrl;
    process.env.SIGUR_EXTERNAL_USERNAME = originalEnv.externalUsername;
    process.env.SIGUR_EXTERNAL_PASSWORD = originalEnv.externalPassword;
  });

  it('prefers complete system_settings Sigur override over env', async () => {
    process.env.SIGUR_EXTERNAL_URL = 'https://env.example';
    process.env.SIGUR_EXTERNAL_USERNAME = 'env-user';
    process.env.SIGUR_EXTERNAL_PASSWORD = 'env-pass';

    mockedState.settingsRows = [
      { key: 'sigur_external_url', value: 'https://db.example' },
      { key: 'sigur_external_username', value: 'db-user' },
      { key: 'sigur_external_password', value: 'db-pass' },
    ];

    const config = await settingsService.getResolvedSigurConnectionConfig('external');

    expect(config).toEqual({
      url: 'https://db.example',
      username: 'db-user',
      password: 'db-pass',
      source: 'system_settings',
    });
    expect(pgQuery.mock.calls[0][0]).toMatch(/SELECT key, value FROM system_settings/i);
  });

  it('falls back to env when database override is incomplete', async () => {
    process.env.SIGUR_INTERNAL_URL = 'https://env-internal.example';
    process.env.SIGUR_INTERNAL_USERNAME = 'env-internal-user';
    process.env.SIGUR_INTERNAL_PASSWORD = 'env-internal-pass';

    mockedState.settingsRows = [
      { key: 'sigur_internal_url', value: 'https://db-internal.example' },
      { key: 'sigur_internal_username', value: 'db-internal-user' },
    ];

    const config = await settingsService.getResolvedSigurConnectionConfig('internal');

    expect(config).toEqual({
      url: 'https://env-internal.example',
      username: 'env-internal-user',
      password: 'env-internal-pass',
      source: 'env',
    });
  });
});
