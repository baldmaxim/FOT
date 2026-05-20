import axios, { AxiosError, AxiosInstance } from 'axios';
import { settingsService, assertMtsBaseUrlAllowed } from './settings.service.js';

// Базовый сервис МТС «Мобильные сотрудники» (M-Poisk REST v6).
// Контракт зафиксирован в docs/mts-mobile-staff-api.md.
// Авторизация — статический Bearer-токен из системных настроек (хранится
// зашифрованным; settingsService.getResolvedMtsConfig() его расшифровывает).

const MTS_TIMEOUTS = {
  quick: 15_000,
  bulk: 30_000,
} as const;

const MTS_MAX_CONCURRENCY = Math.max(1, Number(process.env.MTS_MAX_CONCURRENCY) || 2);
const MTS_RETRY_STATUSES = new Set([429, 502, 503, 504]);
const MTS_RETRY_CODES = new Set(['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EAI_AGAIN']);
const MTS_RETRY_ATTEMPTS = 3;
const MTS_RETRY_BASE_MS = 500;

/** Ошибка вызова МТС API с разобранным конвертом { status, code, description, message }. */
export class MtsApiError extends Error {
  status: number;
  code?: number;
  description?: string;

  constructor(message: string, status: number, code?: number, description?: string) {
    super(message);
    this.name = 'MtsApiError';
    this.status = status;
    this.code = code;
    this.description = description;
  }
}

class MtsRequestLimiter {
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

const limiter = new MtsRequestLimiter(MTS_MAX_CONCURRENCY);

export class MtsServiceBase {
  private client: AxiosInstance | null = null;
  private fingerprint = '';

  /** Настроен ли модуль (есть резолвимый токен). */
  async isConfigured(): Promise<boolean> {
    return (await settingsService.getResolvedMtsConfig()) !== null;
  }

  private async getClient(): Promise<AxiosInstance> {
    const config = await settingsService.getResolvedMtsConfig();
    if (!config) {
      throw new MtsApiError('МТС не настроен: укажите API-токен в настройках модуля', 0);
    }

    const baseURL = config.baseUrl.replace(/\/+$/, '');
    // Защита от SSRF/увода токена: даже если в БД/env осталось что-то нелегитимное,
    // отказываемся слать Bearer в неразрешённый хост.
    assertMtsBaseUrlAllowed(baseURL);
    const nextFingerprint = `${baseURL}::${config.token.slice(0, 8)}:${config.token.length}`;

    if (!this.client || this.fingerprint !== nextFingerprint) {
      this.client = axios.create({
        baseURL,
        timeout: MTS_TIMEOUTS.bulk,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.token}`,
        },
      });
      this.fingerprint = nextFingerprint;
    }

    return this.client;
  }

  /** Сбросить закэшированный клиент (после смены токена/URL). */
  invalidate(): void {
    this.client = null;
    this.fingerprint = '';
  }

  private isRetryable(error: unknown): boolean {
    if (!(error instanceof AxiosError)) return false;
    if (error.response?.status && MTS_RETRY_STATUSES.has(error.response.status)) return true;
    if (error.code && MTS_RETRY_CODES.has(error.code)) return true;
    return false;
  }

  private toMtsError(error: unknown): MtsApiError {
    if (error instanceof AxiosError) {
      const status = error.response?.status ?? 0;
      const body = error.response?.data as
        | { status?: number; code?: number; description?: string; message?: string }
        | undefined;
      const message = body?.message || body?.description || error.message || 'Ошибка вызова МТС API';
      return new MtsApiError(message, status, body?.code, body?.description);
    }
    return new MtsApiError(error instanceof Error ? error.message : String(error), 0);
  }

  protected async request<T>(
    method: 'get' | 'post' | 'put' | 'patch' | 'delete',
    endpoint: string,
    options: { params?: Record<string, unknown>; data?: unknown; timeout?: number } = {},
  ): Promise<T> {
    const release = await limiter.acquire();
    try {
      const client = await this.getClient();
      let attempt = 0;
      let lastError: unknown;

      while (attempt <= MTS_RETRY_ATTEMPTS) {
        try {
          const response = await client.request<T>({
            method,
            url: endpoint,
            params: options.params,
            data: options.data,
            timeout: options.timeout ?? MTS_TIMEOUTS.quick,
          });
          return response.data;
        } catch (error) {
          lastError = error;
          if (attempt >= MTS_RETRY_ATTEMPTS || !this.isRetryable(error)) {
            throw this.toMtsError(error);
          }
          const delay = MTS_RETRY_BASE_MS * Math.pow(2, attempt);
          console.warn(`[mts] retry ${attempt + 1}/${MTS_RETRY_ATTEMPTS} ${method.toUpperCase()} ${endpoint} after ${delay}ms`);
          await new Promise(resolve => setTimeout(resolve, delay));
          attempt++;
        }
      }

      throw this.toMtsError(lastError);
    } finally {
      release();
    }
  }

  /** Достаёт массив элементов из ответа (массив либо { data|items|content: [...] }). */
  protected extractItems<T>(payload: unknown): T[] {
    if (Array.isArray(payload)) return payload as T[];
    if (payload && typeof payload === 'object') {
      for (const key of ['data', 'items', 'content', 'results']) {
        const v = (payload as Record<string, unknown>)[key];
        if (Array.isArray(v)) return v as T[];
      }
    }
    return [];
  }
}
