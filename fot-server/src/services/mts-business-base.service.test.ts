import { describe, it, expect, vi } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';

vi.mock('./settings.service.js', () => ({
  assertMtsBusinessBaseUrlAllowed: vi.fn(),
}));
vi.mock('./mts-business-accounts.service.js', () => ({
  mtsBusinessAccountsService: {},
}));
vi.mock('./mts-business-auth.service.js', () => ({
  mtsBusinessAuthService: {},
}));

import {
  MtsBusinessApiError,
  isFeatureUnavailable,
  isTransientMtsError,
  isRetryableMtsAxiosError,
  mtsBusinessApiErrorFromAxios,
  mtsErrorBucket,
  mtsPermanentErrorKind,
  mtsRetryDelayMs,
  formatMtsErrorBreakdown,
} from './mts-business-base.service.js';

const axiosErrorWithStatus = (status: number, headers: Record<string, string> = {}, data: unknown = {}): AxiosError =>
  new AxiosError('Request failed', 'ERR_BAD_RESPONSE', undefined, undefined, {
    status,
    statusText: 'x',
    headers,
    config: { headers: new AxiosHeaders() },
    data,
  });

describe('МТС Бизнес: разбор ошибок апстрима', () => {
  it('извлекает errorCode из тела ответа', () => {
    const err = new AxiosError('Request failed', 'ERR_BAD_REQUEST', undefined, undefined, {
      status: 421,
      statusText: 'Misdirected Request',
      headers: {},
      config: { headers: new AxiosHeaders() },
      data: {
        errorMessage: 'Сервис Foris временно недоступен',
        sourceID: 'PublicApi',
        errorCode: '3003',
      },
    });
    const apiErr = mtsBusinessApiErrorFromAxios(err, true);
    expect(apiErr.status).toBe(421);
    expect(apiErr.code).toBe('3003');
    expect(apiErr.message).toContain('Foris');
  });

  it('isTransientMtsError true для 421/3003', () => {
    const err = new MtsBusinessApiError('Foris', 421, '3003');
    expect(isTransientMtsError(err)).toBe(true);
  });

  it('isTransientMtsError false для 403/1010 и прочих', () => {
    expect(isTransientMtsError(new MtsBusinessApiError('нет в тарифе', 403, '1010'))).toBe(false);
    expect(isTransientMtsError(new MtsBusinessApiError('другое', 421, '9999'))).toBe(false);
    expect(isFeatureUnavailable(new MtsBusinessApiError('нет в тарифе', 403, '1010'))).toBe(true);
  });
});

describe('МТС Бизнес: решение о ретрае', () => {
  it('500 ретраится только при retryOn500 (read-only вызовы)', () => {
    const err = axiosErrorWithStatus(500);
    expect(isRetryableMtsAxiosError(err, true)).toBe(true);
    expect(isRetryableMtsAxiosError(err, false)).toBe(false);
  });

  it('429/502/503/504 и сетевые обрывы ретраятся независимо от retryOn500', () => {
    expect(isRetryableMtsAxiosError(axiosErrorWithStatus(429), false)).toBe(true);
    expect(isRetryableMtsAxiosError(axiosErrorWithStatus(503), false)).toBe(true);
    const netErr = new AxiosError('timeout', 'ECONNABORTED');
    expect(isRetryableMtsAxiosError(netErr, false)).toBe(true);
  });

  it('421/3003 (Foris) ретраится, 400 и не-Axios — нет', () => {
    const foris = axiosErrorWithStatus(421, {}, { errorCode: '3003' });
    expect(isRetryableMtsAxiosError(foris, false)).toBe(true);
    expect(isRetryableMtsAxiosError(axiosErrorWithStatus(400), true)).toBe(false);
    expect(isRetryableMtsAxiosError(new Error('обычная ошибка'), true)).toBe(false);
  });
});

describe('МТС Бизнес: пауза перед ретраем', () => {
  it('429 без Retry-After — 20с (окно лимита 60с)', () => {
    expect(mtsRetryDelayMs(axiosErrorWithStatus(429), 0)).toBe(20_000);
  });

  it('429 с Retry-After — берём заголовок с потолком 60с', () => {
    expect(mtsRetryDelayMs(axiosErrorWithStatus(429, { 'retry-after': '5' }), 0)).toBe(5_000);
    expect(mtsRetryDelayMs(axiosErrorWithStatus(429, { 'retry-after': '999' }), 0)).toBe(60_000);
  });

  it('прочие ошибки — экспонента 0.5с·2^attempt', () => {
    expect(mtsRetryDelayMs(axiosErrorWithStatus(503), 0)).toBe(500);
    expect(mtsRetryDelayMs(axiosErrorWithStatus(503), 2)).toBe(2_000);
  });
});

describe('МТС Бизнес: стабильные состояния номера (не сбой прогона)', () => {
  it('401/1014 → no_access, 422/2005 → no_binding, 404 → no_data', () => {
    expect(mtsPermanentErrorKind(new MtsBusinessApiError('unauthorized', 401, '1014'))).toBe('no_access');
    expect(mtsPermanentErrorKind(new MtsBusinessApiError('нет связки', 422, '2005'))).toBe('no_binding');
    expect(mtsPermanentErrorKind(new MtsBusinessApiError('not found', 404))).toBe('no_data');
  });

  it('401 без кода — тоже no_access (гейт МТС отдаёт тело без парсируемого кода)', () => {
    expect(mtsPermanentErrorKind(new MtsBusinessApiError('unauthorized', 401))).toBe('no_access');
  });

  it('401 с посторонним кодом, прочие 422 и не-API ошибки — null (обычная обработка)', () => {
    expect(mtsPermanentErrorKind(new MtsBusinessApiError('другое', 401, '9999'))).toBeNull();
    expect(mtsPermanentErrorKind(new MtsBusinessApiError('validation', 422, '9999'))).toBeNull();
    expect(mtsPermanentErrorKind(new Error('ошибка БД'))).toBeNull();
  });
});

describe('МТС Бизнес: тело ошибки строкой (гейт не всегда отдаёт JSON-объект)', () => {
  it('JSON-строка в data — код и сообщение извлекаются', () => {
    const err = new AxiosError('Request failed', 'ERR_BAD_REQUEST', undefined, undefined, {
      status: 401,
      statusText: 'Unauthorized',
      headers: {},
      config: { headers: new AxiosHeaders() },
      data: '{"errorCode":1014,"errorMessage":"unauthorized"}',
    });
    const apiErr = mtsBusinessApiErrorFromAxios(err, true);
    expect(apiErr.status).toBe(401);
    expect(apiErr.code).toBe('1014');
    expect(apiErr.message).toContain('unauthorized');
  });

  it('не-JSON строка — статус остаётся, код отсутствует', () => {
    const err = axiosErrorWithStatus(401, {}, 'Unauthorized');
    const apiErr = mtsBusinessApiErrorFromAxios(err, true);
    expect(apiErr.status).toBe(401);
    expect(apiErr.code).toBeUndefined();
  });
});

describe('МТС Бизнес: сводка классов ошибок', () => {
  it('mtsErrorBucket: http-статус с кодом и без, сеть, не-API', () => {
    expect(mtsErrorBucket(new MtsBusinessApiError('EJB', 500, '9999'))).toBe('http 500/9999');
    expect(mtsErrorBucket(new MtsBusinessApiError('bad gateway', 502))).toBe('http 502');
    expect(mtsErrorBucket(new MtsBusinessApiError('timeout', 0))).toBe('сеть/таймаут');
    expect(mtsErrorBucket(new Error('ошибка БД'))).toBe('другое');
  });

  it('formatMtsErrorBreakdown: по убыванию частоты', () => {
    expect(formatMtsErrorBreakdown({ 'http 500': 2, 'сеть/таймаут': 5 })).toBe('сеть/таймаут×5, http 500×2');
    expect(formatMtsErrorBreakdown({})).toBe('');
  });
});
