import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios, { AxiosError, AxiosHeaders } from 'axios';

// Повторы на уровне HTTP-транспорта: у мутации (retryPolicy mutation) при
// неизвестном исходе запрос уходит в МТС ровно один раз.

vi.mock('./settings.service.js', () => ({ assertMtsBusinessBaseUrlAllowed: vi.fn() }));
vi.mock('./mts-business-accounts.service.js', () => ({
  mtsBusinessAccountsService: {
    getResolvedAccount: vi.fn(async () => ({ baseUrl: 'https://api.mts.ru/b2b/v1', rateLimitPerMin: 300 })),
  },
}));
vi.mock('./mts-business-auth.service.js', () => ({
  mtsBusinessAuthService: {
    getAccessToken: vi.fn(async () => 'token'),
    invalidate: vi.fn(),
  },
}));

import { MtsBusinessServiceBase, MtsBusinessApiError, mtsMutationSendOutcome, type MtsRetryPolicy } from './mts-business-base.service.js';
import { mtsBusinessAuthService } from './mts-business-auth.service.js';

class Probe extends MtsBusinessServiceBase {
  call(retryPolicy: MtsRetryPolicy): Promise<unknown> {
    return this.request('post', '/Product/ModifyProduct', { accountId: 'acc-1', data: {}, retryPolicy });
  }
}

const httpError = (status: number, data: unknown = {}): AxiosError =>
  new AxiosError('Request failed', 'ERR_BAD_RESPONSE', undefined, undefined, {
    status, statusText: 'x', headers: {}, config: { headers: new AxiosHeaders() }, data,
  });

const transport = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(axios, 'create').mockReturnValue({ request: transport } as never);
});

describe('МТС Бизнес: транспорт мутаций', () => {
  const cases: Array<[string, () => unknown]> = [
    ['тайм-аут', () => new AxiosError('timeout of 20000ms exceeded', 'ECONNABORTED')],
    ['обрыв соединения', () => new AxiosError('socket hang up', 'ECONNRESET')],
    ['502', () => httpError(502)],
    ['503', () => httpError(503)],
    ['504', () => httpError(504)],
    ['421/3003', () => httpError(421, { errorCode: '3003', errorMessage: 'Сервис Foris временно недоступен' })],
  ];

  for (const [label, makeError] of cases) {
    it(`${label} → ровно один вызов транспорта`, async () => {
      const probe = new Probe();
      transport.mockReset();
      transport.mockRejectedValue(makeError());

      await expect(probe.call('mutation')).rejects.toBeInstanceOf(MtsBusinessApiError);

      expect(transport).toHaveBeenCalledTimes(1);
    });
  }

  it('тайм-аут мутации — исход unknown; 421 — rejected', async () => {
    const probe = new Probe();
    transport.mockRejectedValueOnce(new AxiosError('timeout', 'ECONNABORTED'));
    const timeout = await probe.call('mutation').catch(e => e);
    expect(mtsMutationSendOutcome(timeout)).toBe('unknown');

    transport.mockRejectedValueOnce(httpError(421, { errorCode: '3003' }));
    const foris = await probe.call('mutation').catch(e => e);
    expect(mtsMutationSendOutcome(foris)).toBe('rejected');
  });

  it('ошибка получения токена до отправки → notSent (запрос в МТС не ушёл)', async () => {
    const probe = new Probe();
    vi.mocked(mtsBusinessAuthService.getAccessToken).mockRejectedValueOnce(new Error('auth down'));

    const err = await probe.call('mutation').catch(e => e);

    expect(transport).not.toHaveBeenCalled();
    expect(mtsMutationSendOutcome(err)).toBe('rejected');
  });

  it('401 → переобмен токена и один повтор (запрос не был обработан)', async () => {
    const probe = new Probe();
    transport.mockRejectedValueOnce(httpError(401)).mockResolvedValueOnce({ status: 200, data: { eventID: 'EV' } });

    await expect(probe.call('mutation')).resolves.toEqual({ eventID: 'EV' });

    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('чтение (read) по-прежнему повторяет 503', async () => {
    vi.useFakeTimers();
    try {
      const probe = new Probe();
      transport.mockRejectedValueOnce(httpError(503)).mockResolvedValueOnce({ status: 200, data: [] });
      const pending = probe.call('read');
      await vi.runAllTimersAsync();
      await expect(pending).resolves.toEqual([]);
      expect(transport).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
