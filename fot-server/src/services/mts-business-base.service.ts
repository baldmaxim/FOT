import axios, { AxiosError, AxiosInstance } from 'axios';
import { assertMtsBusinessBaseUrlAllowed } from './settings.service.js';
import { mtsBusinessAccountsService } from './mts-business-accounts.service.js';
import { mtsBusinessAuthService } from './mts-business-auth.service.js';

// Базовый HTTP-клиент МТС «Бизнес» (Business API, api.mts.ru/b2b/v1).
// Мультиаккаунт: каждый вызов передаёт accountId — токен и base URL берутся из
// этого аккаунта. Bearer из mtsBusinessAuthService (логин/пароль → access_token
// с TTL). На 401 — один принудительный переобмен токена аккаунта и повтор.

const MTS_BIZ_TIMEOUTS = {
  quick: 20_000,
  bulk: 30_000,
} as const;

// 4 по умолчанию: карточка номера собирает ~9 разных эндпоинтов параллельно —
// при 2 это 5 «волн» и заметная задержка. Rate-gate (60/300 в мин на аккаунт)
// всё равно защищает от перегруза; concurrency лишь ограничивает одновременные.
const MTS_BIZ_MAX_CONCURRENCY = Math.max(1, Number(process.env.MTS_BUSINESS_MAX_CONCURRENCY) || 4);
const MTS_BIZ_RETRY_STATUSES = new Set([429, 502, 503, 504]);
const MTS_BIZ_RETRY_CODES = new Set(['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EAI_AGAIN']);
const MTS_BIZ_RETRY_ATTEMPTS = 3;
const MTS_BIZ_RETRY_BASE_MS = 500;

/** Ошибка вызова МТС Бизнес API с разобранным конвертом. Без ПДн в message. */
export class MtsBusinessApiError extends Error {
  status: number;
  code?: string;
  description?: string;

  constructor(message: string, status: number, code?: string, description?: string) {
    super(message);
    this.name = 'MtsBusinessApiError';
    this.status = status;
    this.code = code;
    this.description = description;
  }
}

// 403/1010 — «Запрос не авторизован: сервис заблокирован или подписка не
// найдена» (support.mts.ru, раздел кодов ошибок): аккаунт не подключил эту
// функцию в тарифе. Не баг и не повод для Sentry — контроллеры должны
// отдавать { unavailable: true }, а не 5xx.
export const isFeatureUnavailable = (error: unknown): boolean =>
  error instanceof MtsBusinessApiError && error.status === 403 && error.code === '1010';

class MtsBusinessRequestLimiter {
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.max) {
      this.active++;
      return () => this.release();
    }
    await new Promise<void>(resolve => this.queue.push(resolve));
    this.active++;
    return () => this.release();
  }

  private release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

const limiter = new MtsBusinessRequestLimiter(MTS_BIZ_MAX_CONCURRENCY);

// Гейт на тариф пакета запросов МТС (60 или 300/мин, задаётся per-аккаунт в
// mts_business_accounts.rate_limit_per_min). Скользящее окно 60с: при
// исчерпании — не ошибка, а ожидание освобождения окна (не роняем запрос).
class MtsBusinessRateGate {
  private timestamps = new Map<string, number[]>();

  async acquire(accountId: string, limitPerMin: number): Promise<void> {
    const windowMs = 60_000;
    for (;;) {
      const now = Date.now();
      let arr = this.timestamps.get(accountId);
      if (!arr) {
        arr = [];
        this.timestamps.set(accountId, arr);
      }
      while (arr.length && now - arr[0] >= windowMs) arr.shift();
      if (arr.length < limitPerMin) {
        arr.push(now);
        return;
      }
      const waitMs = windowMs - (now - arr[0]) + 10;
      console.warn(`[mts-biz] rate-limit ${limitPerMin}/мин account=${accountId} — жду ${waitMs}ms`);
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
  }
}

const rateGate = new MtsBusinessRateGate();

export class MtsBusinessServiceBase {
  // axios-клиент кэшируется per baseURL (у разных аккаунтов может отличаться).
  private clients = new Map<string, AxiosInstance>();

  /** Клиент без Authorization: токен подставляется per-request (меняется по TTL). */
  private async getClient(accountId: string): Promise<{ client: AxiosInstance; baseURL: string; rateLimitPerMin: number }> {
    const account = await mtsBusinessAccountsService.getResolvedAccount(accountId);
    if (!account) {
      throw new MtsBusinessApiError('МТС Бизнес: аккаунт не найден или без пароля', 0);
    }
    const baseURL = account.baseUrl.replace(/\/+$/, '');
    assertMtsBusinessBaseUrlAllowed(baseURL);

    let client = this.clients.get(baseURL);
    if (!client) {
      client = axios.create({
        baseURL,
        timeout: MTS_BIZ_TIMEOUTS.bulk,
        headers: { 'Content-Type': 'application/json' },
      });
      this.clients.set(baseURL, client);
    }
    return { client, baseURL, rateLimitPerMin: account.rateLimitPerMin };
  }

  /** Сбросить кэш axios-клиентов (после смены base URL аккаунтов). */
  invalidate(): void {
    this.clients.clear();
  }

  private isRetryable(error: unknown): boolean {
    if (!(error instanceof AxiosError)) return false;
    if (error.response?.status && MTS_BIZ_RETRY_STATUSES.has(error.response.status)) return true;
    if (error.code && MTS_BIZ_RETRY_CODES.has(error.code)) return true;
    return false;
  }

  private isUnauthorized(error: unknown): boolean {
    return error instanceof AxiosError && (error.response?.status === 401 || error.response?.status === 403);
  }

  private toApiError(error: unknown, suppressBodyLog = false): MtsBusinessApiError {
    if (error instanceof MtsBusinessApiError) return error;
    if (error instanceof AxiosError) {
      const status = error.response?.status ?? 0;
      const body = error.response?.data as
        | { code?: string | number; description?: string; message?: string; error_description?: string }
        | undefined;
      const code = body?.code != null ? String(body.code) : undefined;
      const message = body?.message || body?.error_description || body?.description || error.message || 'Ошибка вызова МТС Бизнес API';
      // Тело ошибки апстрима (усечённое) — единственный источник причины,
      // когда МТС отвечает 4xx/5xx без стандартных полей. ПДн там нет — КРОМЕ
      // PersonalData/* (паспорт/адрес), там suppressBodyLog=true (см. request()).
      if (!suppressBodyLog && error.response?.data !== undefined) {
        let snippet = '';
        try { snippet = JSON.stringify(error.response.data); } catch { snippet = String(error.response.data); }
        console.error(`[mts-biz] upstream ${status} body: ${snippet.slice(0, 500)}`);
      }
      return new MtsBusinessApiError(message, status, code, body?.description);
    }
    return new MtsBusinessApiError(error instanceof Error ? error.message : String(error), 0);
  }

  protected async request<T>(
    method: 'get' | 'post' | 'put' | 'patch' | 'delete',
    endpoint: string,
    options: { accountId: string; params?: Record<string, unknown>; data?: unknown; timeout?: number; suppressErrorBodyLog?: boolean },
  ): Promise<T> {
    const { accountId } = options;
    const release = await limiter.acquire();
    const m = method.toUpperCase();
    // Тело может содержать номера/email — НЕ логируем body, только endpoint.
    console.log(`[mts-biz] → ${m} ${endpoint} account=${accountId}`);
    const tStart = Date.now();
    try {
      const { client, rateLimitPerMin } = await this.getClient(accountId);
      let attempt = 0;
      let reauthTried = false;
      let lastError: unknown;

      while (attempt <= MTS_BIZ_RETRY_ATTEMPTS) {
        try {
          await rateGate.acquire(accountId, rateLimitPerMin);
          const token = await mtsBusinessAuthService.getAccessToken(accountId);
          const response = await client.request<T>({
            method,
            url: endpoint,
            params: options.params,
            data: options.data,
            timeout: options.timeout ?? MTS_BIZ_TIMEOUTS.quick,
            headers: { Authorization: `Bearer ${token}` },
          });
          console.log(`[mts-biz] ← ${response.status} ${m} ${endpoint} ${Date.now() - tStart}ms`);
          return response.data;
        } catch (error) {
          lastError = error;
          if (this.isUnauthorized(error) && !reauthTried) {
            reauthTried = true;
            mtsBusinessAuthService.invalidate(accountId);
            console.warn(`[mts-biz] 401/403 ${m} ${endpoint} — переобмен токена account=${accountId}`);
            continue;
          }
          if (attempt >= MTS_BIZ_RETRY_ATTEMPTS || !this.isRetryable(error)) {
            const apiErr = this.toApiError(error, options.suppressErrorBodyLog);
            console.error(
              `[mts-biz] ✗ ${m} ${endpoint} ${Date.now() - tStart}ms http=${apiErr.status} code=${apiErr.code ?? '-'}`,
            );
            throw apiErr;
          }
          const delay = MTS_BIZ_RETRY_BASE_MS * Math.pow(2, attempt);
          console.warn(`[mts-biz] retry ${attempt + 1}/${MTS_BIZ_RETRY_ATTEMPTS} ${m} ${endpoint} after ${delay}ms`);
          await new Promise(resolve => setTimeout(resolve, delay));
          attempt++;
        }
      }
      throw this.toApiError(lastError, options.suppressErrorBodyLog);
    } finally {
      release();
    }
  }
}
