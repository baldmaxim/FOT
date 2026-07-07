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
  mtsBusinessApiErrorFromAxios,
} from './mts-business-base.service.js';

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
