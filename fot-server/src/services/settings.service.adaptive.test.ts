import { beforeEach, describe, expect, it, vi } from 'vitest';

const { pgQuery, pgExecute } = vi.hoisted(() => ({
  pgQuery: vi.fn(),
  pgExecute: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  query: pgQuery,
  queryOne: vi.fn(),
  execute: pgExecute,
  withTransaction: vi.fn(),
}));

import {
  isAllowedOcrModel,
  isAllowedTextModel,
  isKnownOpenRouterModel,
  isTrustedLlmBaseUrl,
  settingsService,
} from './settings.service.js';

const seedSettings = (rows: Record<string, string | null>) => {
  settingsService.invalidateCache();
  pgQuery.mockResolvedValue(Object.entries(rows).map(([key, value]) => ({ key, value })));
};

beforeEach(() => {
  vi.clearAllMocks();
  pgExecute.mockResolvedValue(1);
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_BASE_URL;
});

describe('модельные предикаты (разделение по назначению)', () => {
  it('Luna известна, разрешена для тестирования, НЕ разрешена для OCR', () => {
    expect(isKnownOpenRouterModel('openai/gpt-5.6-luna')).toBe(true);
    expect(isAllowedTextModel('openai/gpt-5.6-luna')).toBe(true);
    expect(isAllowedOcrModel('openai/gpt-5.6-luna')).toBe(false);
  });

  it('OCR-модель Gemini не разрешена для тестирования', () => {
    expect(isAllowedOcrModel('google/gemini-2.5-flash')).toBe(true);
    expect(isAllowedTextModel('google/gemini-2.5-flash')).toBe(false);
  });

  it('неизвестная модель отклоняется всеми предикатами', () => {
    expect(isKnownOpenRouterModel('foo/bar')).toBe(false);
    expect(isAllowedOcrModel('foo/bar')).toBe(false);
    expect(isAllowedTextModel('foo/bar')).toBe(false);
  });
});

describe('isTrustedLlmBaseUrl (anti-SSRF)', () => {
  it('точное совпадение и трейлинг-слэш проходят', () => {
    expect(isTrustedLlmBaseUrl('https://proxyllm.fvds.ru/api/v1')).toBe(true);
    expect(isTrustedLlmBaseUrl('https://proxyllm.fvds.ru/api/v1/')).toBe(true);
  });

  it('произвольные/изменённые URL отклоняются', () => {
    expect(isTrustedLlmBaseUrl('http://proxyllm.fvds.ru/api/v1')).toBe(false);
    expect(isTrustedLlmBaseUrl('https://openrouter.ai/api/v1')).toBe(false);
    expect(isTrustedLlmBaseUrl('https://proxyllm.fvds.ru/api/v1?x=1')).toBe(false);
    expect(isTrustedLlmBaseUrl('https://evil.example/api/v1')).toBe(false);
    expect(isTrustedLlmBaseUrl('')).toBe(false);
  });
});

describe('getResolvedAdaptiveLlmConfig', () => {
  it('shared_proxy наследует ТОЛЬКО ключ и URL: openrouter_enabled=false не мешает', async () => {
    seedSettings({
      openrouter_enabled: 'false', // OCR выключен — тестирование живёт
      openrouter_api_key: 'sk-shared',
      openrouter_base_url: 'https://proxyllm.fvds.ru/api/v1',
      adaptive_testing_model: 'openai/gpt-5.6-luna',
    });
    const config = await settingsService.getResolvedAdaptiveLlmConfig();
    expect(config).toMatchObject({
      ok: true,
      apiKey: 'sk-shared',
      baseUrl: 'https://proxyllm.fvds.ru/api/v1',
      model: 'openai/gpt-5.6-luna',
    });
  });

  it('унаследованный произвольный base URL вне allowlist → invalid_base_url, вызова не будет', async () => {
    seedSettings({
      openrouter_api_key: 'sk-shared',
      openrouter_base_url: 'https://openrouter.ai/api/v1', // прямой OpenRouter недоступен и не доверен
      adaptive_testing_model: 'openai/gpt-5.6-luna',
    });
    const config = await settingsService.getResolvedAdaptiveLlmConfig();
    expect(config).toEqual({ ok: false, reason: 'invalid_base_url' });
  });

  it('без ключа → no_api_key', async () => {
    seedSettings({
      openrouter_base_url: 'https://proxyllm.fvds.ru/api/v1',
      adaptive_testing_model: 'openai/gpt-5.6-luna',
    });
    const config = await settingsService.getResolvedAdaptiveLlmConfig();
    expect(config).toEqual({ ok: false, reason: 'no_api_key' });
  });

  it('не-текстовая модель → invalid_model', async () => {
    seedSettings({
      openrouter_api_key: 'sk-shared',
      openrouter_base_url: 'https://proxyllm.fvds.ru/api/v1',
      adaptive_testing_model: 'google/gemini-2.5-flash',
    });
    const config = await settingsService.getResolvedAdaptiveLlmConfig();
    expect(config).toEqual({ ok: false, reason: 'invalid_model' });
  });
});

describe('setAdaptiveTestingSettings (fail-closed правила)', () => {
  it('«*» запрещена без включённого ZDR и пройденной ZDR-проверки', async () => {
    seedSettings({});
    await expect(
      settingsService.setAdaptiveTestingSettings({ allowedEmails: '*' }, 'user-1'),
    ).rejects.toThrow(/ZDR/);
  });

  it('«*» проходит при zdr_required=true и отметке проверки', async () => {
    seedSettings({
      adaptive_testing_zdr_required: 'true',
      adaptive_testing_zdr_verified_at: '2026-07-17T00:00:00Z',
      openrouter_api_key: 'sk-shared',
      openrouter_base_url: 'https://proxyllm.fvds.ru/api/v1',
    });
    await expect(
      settingsService.setAdaptiveTestingSettings({ allowedEmails: '*' }, 'user-1'),
    ).resolves.toBeTruthy();
  });

  it('не-текстовая модель отклоняется при сохранении, а не при вызове', async () => {
    seedSettings({});
    await expect(
      settingsService.setAdaptiveTestingSettings({ model: 'google/gemini-2.5-flash' }, 'user-1'),
    ).rejects.toThrow(/не разрешена/);
  });

  it('маска вместо ключа не сохраняется', async () => {
    seedSettings({});
    await expect(
      settingsService.setAdaptiveTestingSettings(
        { dedicated: { apiKey: '••••••••', baseUrl: 'https://proxyllm.fvds.ru/api/v1' } },
        'user-1',
      ),
    ).rejects.toThrow(/маска/);
  });

  it('dedicated с недоверенным URL отклоняется', async () => {
    seedSettings({});
    await expect(
      settingsService.setAdaptiveTestingSettings(
        { dedicated: { apiKey: 'sk-or-v1-x', baseUrl: 'https://evil.example/api/v1' } },
        'user-1',
      ),
    ).rejects.toThrow(/доверенных/);
  });

  it('переключение на dedicated_proxy без сохранённой пары ключ+URL отклоняется', async () => {
    seedSettings({});
    await expect(
      settingsService.setAdaptiveTestingSettings({ connectionMode: 'dedicated_proxy' }, 'user-1'),
    ).rejects.toThrow(/ключ и Base URL/);
  });
});
