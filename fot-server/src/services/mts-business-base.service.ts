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

// 8 по умолчанию: карточка номера собирает ~9 эндпоинтов параллельно, а
// оркестратор «Обновить всё» гонит два аккаунта × пул 3 одновременно — при 4
// они голодали бы. Rate-gate (60/300 в мин на аккаунт) всё равно защищает от
// перегруза; concurrency лишь ограничивает одновременные соединения.
const MTS_BIZ_MAX_CONCURRENCY = Math.max(1, Number(process.env.MTS_BUSINESS_MAX_CONCURRENCY) || 8);
const MTS_BIZ_RETRY_STATUSES = new Set([429, 502, 503, 504]);
const MTS_BIZ_RETRY_CODES = new Set(['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EAI_AGAIN']);
const MTS_BIZ_RETRY_ATTEMPTS = 3;
const MTS_BIZ_RETRY_BASE_MS = 500;
// 429 живёт окном 60с — экспонента 0.5/1/2с его не переживает. Без Retry-After
// ждём треть окна: до исчерпания попыток успеваем перешагнуть границу окна.
const MTS_BIZ_RETRY_429_MS = 20_000;
const MTS_BIZ_RETRY_429_MAX_MS = 60_000;

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

// 421/3003 — «Сервис Foris временно недоступен»: транзиентный сбой апстрима МТС,
// не «не в тарифе» и не баг портала. Ретраим; в sync считаем transient, не failed.
export const isTransientMtsError = (error: unknown): boolean =>
  error instanceof MtsBusinessApiError && error.status === 421 && error.code === '3003';

/**
 * Постоянные «ошибки» = свойства номера, а не сбой прогона (по логам ночного
 * прогона 07.07.2026, support.mts.ru коды):
 *  - 401/1014 «unauthorized» — номер вне доступа портального пользователя
 *    (переехал на другой ЛС/отключён); реавторизация не лечит;
 *  - 422/2005 «Не найдена связка региона/ТП - номер»;
 *  - 404 — данных нет (например, персданные не заведены).
 * Ретраи/повторы бесполезны — считаем отдельными счётчиками, не failed.
 */
export type MtsPermanentErrorKind = 'no_access' | 'no_binding' | 'no_data';

export const mtsPermanentErrorKind = (error: unknown): MtsPermanentErrorKind | null => {
  if (!(error instanceof MtsBusinessApiError)) return null;
  if (error.status === 401 && error.code === '1014') return 'no_access';
  if (error.status === 422 && error.code === '2005') return 'no_binding';
  if (error.status === 404) return 'no_data';
  return null;
};

/**
 * Короткая метка класса ошибки для сводок в статусах прогонов: «http 500/9999»,
 * «сеть/таймаут» (обрыв без ответа), «другое» (не-API, например ошибка БД).
 * Без ПДн — только статус и код МТС.
 */
export const mtsErrorBucket = (error: unknown): string => {
  if (error instanceof MtsBusinessApiError) {
    if (error.status > 0) return error.code ? `http ${error.status}/${error.code}` : `http ${error.status}`;
    return 'сеть/таймаут';
  }
  return 'другое';
};

/** Сводка «bucket×count» по убыванию частоты: «http 500×20, сеть/таймаут×4». */
export const formatMtsErrorBreakdown = (breakdown: Record<string, number>): string =>
  Object.entries(breakdown)
    .sort((a, b) => b[1] - a[1])
    .map(([bucket, count]) => `${bucket}×${count}`)
    .join(', ');

type IMtsErrorBody = {
  code?: string | number;
  errorCode?: string | number;
  description?: string;
  message?: string;
  errorMessage?: string;
  error_description?: string;
};

/** Разбор тела ошибки МТС (errorCode приоритетнее code). Экспорт для тестов. */
export const mtsBusinessApiErrorFromAxios = (error: unknown, suppressBodyLog = false): MtsBusinessApiError => {
  if (error instanceof MtsBusinessApiError) return error;
  if (error instanceof AxiosError) {
    const status = error.response?.status ?? 0;
    const body = error.response?.data as IMtsErrorBody | undefined;
    const code = body?.errorCode != null
      ? String(body.errorCode)
      : body?.code != null
        ? String(body.code)
        : undefined;
    const message = body?.errorMessage
      || body?.message
      || body?.error_description
      || body?.description
      || error.message
      || 'Ошибка вызова МТС Бизнес API';
    if (!suppressBodyLog && error.response?.data !== undefined) {
      let snippet = '';
      try { snippet = JSON.stringify(error.response.data); } catch { snippet = String(error.response.data); }
      console.error(`[mts-biz] upstream ${status} body: ${snippet.slice(0, 500)}`);
    }
    return new MtsBusinessApiError(message, status, code, body?.description);
  }
  return new MtsBusinessApiError(error instanceof Error ? error.message : String(error), 0);
};

/**
 * Ретраить ли вызов. Всегда: 429/502/503/504, сетевые обрывы, 421/3003 «Foris
 * временно недоступен». 500 — только для read-only вызовов (retryOn500):
 * в ночные регламентные работы МТС отдаёт голые 500 «EJB Exception» на чтениях
 * (см. BillPlanInfo в catalog-сервисе); мутации ChangePersonalData на 500 не
 * повторяем — исход первой попытки неизвестен. Экспорт для тестов.
 */
export const isRetryableMtsAxiosError = (error: unknown, retryOn500: boolean): boolean => {
  if (!(error instanceof AxiosError)) return false;
  const status = error.response?.status;
  if (status && MTS_BIZ_RETRY_STATUSES.has(status)) return true;
  if (status === 500 && retryOn500) return true;
  if (error.code && MTS_BIZ_RETRY_CODES.has(error.code)) return true;
  const body = error.response?.data as IMtsErrorBody | undefined;
  const errCode = body?.errorCode ?? body?.code;
  if (status === 421 && errCode != null && String(errCode) === '3003') return true;
  return false;
};

/**
 * Пауза перед ретраем: 429 — Retry-After (сек, потолок 60с) либо 20с;
 * остальное — экспонента 0.5с·2^attempt. Экспорт для тестов.
 */
export const mtsRetryDelayMs = (error: unknown, attempt: number): number => {
  if (error instanceof AxiosError && error.response?.status === 429) {
    const retryAfter = Number.parseInt(String(error.response.headers?.['retry-after'] ?? ''), 10);
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      return Math.min(retryAfter * 1000, MTS_BIZ_RETRY_429_MAX_MS);
    }
    return MTS_BIZ_RETRY_429_MS;
  }
  return MTS_BIZ_RETRY_BASE_MS * Math.pow(2, attempt);
};

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

  private isUnauthorized(error: unknown): boolean {
    if (!(error instanceof AxiosError)) return false;
    const status = error.response?.status;
    if (status !== 401 && status !== 403) return false;
    // 401/1014 — ресурсный unauthorized (номер вне доступа портального
    // пользователя), токен живой: реавторизация не лечит (проверено логами
    // ночного прогона), а сброс кэша токена на каждом таком номере вреден.
    const body = error.response?.data as IMtsErrorBody | undefined;
    const code = body?.errorCode ?? body?.code;
    if (status === 401 && code != null && String(code) === '1014') return false;
    return true;
  }

  private toApiError(error: unknown, suppressBodyLog = false): MtsBusinessApiError {
    return mtsBusinessApiErrorFromAxios(error, suppressBodyLog);
  }

  protected async request<T>(
    method: 'get' | 'post' | 'put' | 'patch' | 'delete',
    endpoint: string,
    options: {
      accountId: string;
      params?: Record<string, unknown>;
      data?: unknown;
      timeout?: number;
      suppressErrorBodyLog?: boolean;
      // Доп. заголовки per-запрос (PersonalData/ChangePersonalData требует
      // x-soap-action и X-MTS-MSISDN). Authorization всегда подставляется поверх.
      headers?: Record<string, string>;
      /** false — не ретраить HTTP 500 (мутации: исход первой попытки неизвестен). */
      retryOn500?: boolean;
    },
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
            headers: { ...(options.headers ?? {}), Authorization: `Bearer ${token}` },
          });
          console.log(`[mts-biz] ← ${response.status} ${m} ${endpoint} ${Date.now() - tStart}ms`);
          // Диагностика контрактов: сырое тело ответа при MTS_PROBE_RAW=1 (кроме
          // PersonalData — там паспорт/адрес). Email маскируем, тело усекаем.
          // ВРЕМЕННОЕ — снять после сверки парсеров (probe-скрипт).
          if (process.env.MTS_PROBE_RAW === '1' && !endpoint.includes('PersonalData')) {
            let raw = '';
            try { raw = JSON.stringify(response.data); } catch { raw = String(response.data); }
            raw = raw.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '***@***');
            console.log(`[mts-raw] ${endpoint} :: ${raw.slice(0, 4000)}`);
          }
          return response.data;
        } catch (error) {
          lastError = error;
          if (this.isUnauthorized(error) && !reauthTried) {
            reauthTried = true;
            mtsBusinessAuthService.invalidate(accountId);
            console.warn(`[mts-biz] 401/403 ${m} ${endpoint} — переобмен токена account=${accountId}`);
            continue;
          }
          if (attempt >= MTS_BIZ_RETRY_ATTEMPTS || !isRetryableMtsAxiosError(error, options.retryOn500 !== false)) {
            const apiErr = this.toApiError(error, options.suppressErrorBodyLog);
            console.error(
              `[mts-biz] ✗ ${m} ${endpoint} ${Date.now() - tStart}ms http=${apiErr.status} code=${apiErr.code ?? '-'}`,
            );
            throw apiErr;
          }
          const delay = mtsRetryDelayMs(error, attempt);
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
