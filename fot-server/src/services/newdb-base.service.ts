import axios, { AxiosError, AxiosInstance } from 'axios';
import { assertNewdbBaseUrlAllowed, settingsService } from './settings.service.js';

// Базовый HTTP-клиент newdb.net (api.newdb.net/v2). Единый POST-эндпоинт,
// метод выбирается полем params.method. Авторизация — заголовок X-API-KEY
// (НЕ Bearer). Токен статический (без обмена), берётся из system_settings.
//
// ВАЖНО: без ретраев на 429/5xx/таймаут — newdb тарифицирует запросы, повтор =
// дубль-списание. Единственный допустимый ретрай — pre-send ошибка соединения
// (DNS/отказ), когда запрос гарантированно НЕ ушёл на апстрим.

const NEWDB_TIMEOUT_MS = Number(process.env.NEWDB_TIMEOUT_MS) || 60_000;
const NEWDB_PRESEND_RETRY_CODES = new Set(['ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND']);
const NEWDB_PRESEND_RETRY_ATTEMPTS = 1;

/** Ошибка вызова newdb API. Без ПДн в message. */
export class NewdbApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'NewdbApiError';
    this.status = status;
    this.code = code;
  }
}

const newdbApiErrorFromAxios = (error: unknown): NewdbApiError => {
  if (error instanceof NewdbApiError) return error;
  if (error instanceof AxiosError) {
    const status = error.response?.status ?? 0;
    const body = error.response?.data as { message?: string; error?: string; code?: string | number } | undefined;
    const message = body?.message || body?.error || error.message || 'Ошибка вызова newdb API';
    const code = body?.code != null ? String(body.code) : error.code;
    return new NewdbApiError(message, status, code);
  }
  return new NewdbApiError(error instanceof Error ? error.message : String(error), 0);
};

// Ретраим ТОЛЬКО pre-send сетевые ошибки (запрос не ушёл на апстрим).
const isPresendConnError = (error: unknown): boolean =>
  error instanceof AxiosError && !error.response && !!error.code && NEWDB_PRESEND_RETRY_CODES.has(error.code);

class NewdbServiceBase {
  private client: AxiosInstance | null = null;
  private clientBaseUrl = '';
  private clientToken = '';

  /** Сбросить кэш axios-клиента (после смены токена/base URL). */
  invalidate(): void {
    this.client = null;
    this.clientBaseUrl = '';
    this.clientToken = '';
  }

  private async getClient(): Promise<AxiosInstance> {
    const config = await settingsService.getResolvedNewdbConfig();
    if (!config) {
      throw new NewdbApiError('newdb: токен не задан (Система → Проверки → Настройки)', 0);
    }
    const baseURL = config.baseUrl.replace(/\/+$/, '');
    assertNewdbBaseUrlAllowed(baseURL);

    if (this.client && this.clientBaseUrl === baseURL && this.clientToken === config.token) {
      return this.client;
    }

    this.client = axios.create({
      baseURL,
      timeout: NEWDB_TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': config.token,
      },
    });
    this.clientBaseUrl = baseURL;
    this.clientToken = config.token;
    return this.client;
  }

  /** POST на единый эндпоинт v2. Тело содержит ПДн — не логируем. */
  async post<T>(body: unknown): Promise<T> {
    const client = await this.getClient();
    let attempt = 0;
    let lastError: unknown;
    const tStart = Date.now();

    while (attempt <= NEWDB_PRESEND_RETRY_ATTEMPTS) {
      try {
        const response = await client.post<T>('', body);
        console.log(`[newdb] ← ${response.status} POST ${Date.now() - tStart}ms`);
        return response.data;
      } catch (error) {
        lastError = error;
        if (attempt < NEWDB_PRESEND_RETRY_ATTEMPTS && isPresendConnError(error)) {
          const code = (error as AxiosError).code;
          console.warn(`[newdb] pre-send conn error ${code} — retry ${attempt + 1}`);
          await new Promise(resolve => setTimeout(resolve, 500));
          attempt++;
          continue;
        }
        const apiErr = newdbApiErrorFromAxios(error);
        console.error(`[newdb] ✗ POST ${Date.now() - tStart}ms http=${apiErr.status} code=${apiErr.code ?? '-'}`);
        throw apiErr;
      }
    }
    throw newdbApiErrorFromAxios(lastError);
  }
}

export const newdbBaseService = new NewdbServiceBase();
