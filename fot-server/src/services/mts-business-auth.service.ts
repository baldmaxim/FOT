import axios, { AxiosError } from 'axios';
import { assertMtsBusinessBaseUrlAllowed } from './settings.service.js';
import { mtsBusinessAccountsService } from './mts-business-accounts.service.js';

// Авторизация МТС «Бизнес» (Business API): Consumer Key/Secret → access_token
// (Bearer). Токен живёт expires_in (обычно 3600с) — кэшируем В ПАМЯТИ ПО
// accountId (у каждого лицевого счёта свой API) и обновляем заранее либо
// принудительно (после 401 в base-сервисе).
//
// Контракт подтверждён по support.mts.ru («Как получить токен для МТС Бизнес API»):
//   POST https://api.mts.ru/token  (origin базового URL + /token, НЕ под /b2b/v1)
//   Basic Auth: Consumer Key : Consumer Secret (генерируются в ЛК МТС Бизнес)
//   Content-Type: application/x-www-form-urlencoded, тело grant_type=client_credentials
//   → { access_token, token_type: "Bearer", expires_in: 3600, scope }
// В полях аккаунта login/password храним Consumer Key/Consumer Secret.

const AUTH_ENDPOINT = '/token';
const AUTH_TIMEOUT_MS = 15_000;
const EXPIRY_SKEW_MS = 60_000;
const DEFAULT_TTL_SEC = 3600;

/** Ошибка авторизации МТС Бизнес (без ПДн; статус апстрима для диагностики). */
export class MtsBusinessAuthError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'MtsBusinessAuthError';
    this.status = status;
  }
}

const pickToken = (body: unknown): string | null => {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const candidate = b.access_token ?? b.accessToken ?? b.token ?? b.Token;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
};

const pickTtlSec = (body: unknown): number => {
  if (!body || typeof body !== 'object') return DEFAULT_TTL_SEC;
  const b = body as Record<string, unknown>;
  const raw = b.expires_in ?? b.expiresIn ?? b.expires ?? b.ttl;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_SEC;
};

interface TokenEntry {
  token: string;
  expiresAt: number;
}

class MtsBusinessAuthService {
  private cache = new Map<string, TokenEntry>();
  private inflight = new Map<string, Promise<string>>();

  /**
   * Актуальный Bearer-токен для аккаунта. Из кэша, пока не истёк; иначе обмен
   * логин/пароль. force=true форсирует переобмен (после 401).
   */
  async getAccessToken(accountId: string, force = false): Promise<string> {
    const now = Date.now();
    const cached = this.cache.get(accountId);
    if (!force && cached && now < cached.expiresAt - EXPIRY_SKEW_MS) {
      return cached.token;
    }
    const existing = this.inflight.get(accountId);
    if (existing) return existing;

    const promise = this.fetchToken(accountId).finally(() => {
      this.inflight.delete(accountId);
    });
    this.inflight.set(accountId, promise);
    return promise;
  }

  /** Сбросить кэш токена: одного аккаунта или всех. */
  invalidate(accountId?: string): void {
    if (accountId) this.cache.delete(accountId);
    else this.cache.clear();
  }

  private async fetchToken(accountId: string): Promise<string> {
    const account = await mtsBusinessAccountsService.getResolvedAccount(accountId);
    if (!account) {
      throw new MtsBusinessAuthError('МТС Бизнес: аккаунт не найден или без пароля', 0);
    }
    const baseURL = account.baseUrl.replace(/\/+$/, '');
    assertMtsBusinessBaseUrlAllowed(baseURL);
    // Токен выдаётся на корне хоста (https://api.mts.ru/token), а не под /b2b/v1.
    const tokenUrl = `${new URL(baseURL).origin}${AUTH_ENDPOINT}`;

    const tStart = Date.now();
    try {
      const response = await axios.post(
        tokenUrl,
        new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
        {
          timeout: AUTH_TIMEOUT_MS,
          auth: { username: account.login, password: account.password },
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        },
      );
      const token = pickToken(response.data);
      if (!token) {
        throw new MtsBusinessAuthError('МТС Бизнес: ответ авторизации без access_token', response.status);
      }
      const ttlSec = pickTtlSec(response.data);
      this.cache.set(accountId, { token, expiresAt: Date.now() + ttlSec * 1000 });
      console.log(`[mts-biz-auth] token obtained account=${accountId} ${Date.now() - tStart}ms ttl=${ttlSec}s`);
      return token;
    } catch (error) {
      this.invalidate(accountId);
      if (error instanceof AxiosError) {
        const status = error.response?.status ?? 0;
        console.error(`[mts-biz-auth] token error account=${accountId} http=${status}`);
        throw new MtsBusinessAuthError('Ошибка авторизации в МТС Бизнес', status);
      }
      if (error instanceof MtsBusinessAuthError) throw error;
      console.error('[mts-biz-auth] token error:', error instanceof Error ? error.message : 'unknown');
      throw new MtsBusinessAuthError('Ошибка авторизации в МТС Бизнес', 0);
    }
  }
}

export const mtsBusinessAuthService = new MtsBusinessAuthService();
