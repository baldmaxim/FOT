import axios, { AxiosInstance, AxiosError } from 'axios';
import https from 'https';
import { IS_PRODUCTION } from '../config/features.js';
import { settingsService } from './settings.service.js';

export type ConnectionType = 'external' | 'internal';

interface SigurConnectionConfig {
  url: string;
  username: string;
  password: string;
}

interface SigurTokenInfo {
  token: string;
  refreshToken: string;
  expiresAt: string;
  authenticatedAt: number;
}

const PAGE_SIZE = 3000;

export const SIGUR_TIMEOUTS = {
  auth: 30_000,
  quick: 15_000,
  bulk: 120_000,
} as const;

const SIGUR_MAX_CONCURRENCY = Math.max(1, Number(process.env.SIGUR_MAX_CONCURRENCY) || 3);
const SIGUR_RETRY_STATUSES = new Set([429, 502, 503, 504]);
const SIGUR_RETRY_CODES = new Set(['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EAI_AGAIN']);
const SIGUR_RETRY_ATTEMPTS = 3;
const SIGUR_RETRY_BASE_MS = 500;

class SigurRequestLimiter {
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

const sigurLimiter = new SigurRequestLimiter(SIGUR_MAX_CONCURRENCY);
let sigurLimiterLogged = false;

/**
 * Базовый сервис для взаимодействия с Sigur REST API.
 * Содержит ядро: авторизацию, запросы, пагинацию.
 */
export class SigurServiceBase {
  private tokens: Partial<Record<ConnectionType, SigurTokenInfo>> = {};
  private clients: Partial<Record<ConnectionType, AxiosInstance>> = {};
  private connectionFingerprints: Partial<Record<ConnectionType, string>> = {};

  private async getConnectionConfig(type: ConnectionType): Promise<SigurConnectionConfig | null> {
    if (IS_PRODUCTION && type === 'internal') return null;

    const resolved = await settingsService.getResolvedSigurConnectionConfig(type);
    if (!resolved) return null;

    return {
      url: resolved.url,
      username: resolved.username,
      password: resolved.password,
    };
  }

  private async isConnectionAvailable(type: ConnectionType): Promise<boolean> {
    return (await this.getConnectionConfig(type)) !== null;
  }

  private getConfigFingerprint(config: SigurConnectionConfig): string {
    return `${config.url}::${config.username}`;
  }

  private async ensureFreshConnectionState(connection: ConnectionType): Promise<SigurConnectionConfig> {
    const config = await this.getConnectionConfig(connection);
    if (!config) {
      throw new Error(
        IS_PRODUCTION
          ? 'Sigur не настроен. В production требуется внешний канал Sigur'
          : 'Sigur не настроен. Укажите параметры подключения во временных настройках или в .env',
      );
    }

    const nextFingerprint = this.getConfigFingerprint(config);
    const previousFingerprint = this.connectionFingerprints[connection];

    if (previousFingerprint && previousFingerprint !== nextFingerprint) {
      delete this.tokens[connection];
      delete this.clients[connection];
    }

    this.connectionFingerprints[connection] = nextFingerprint;
    return config;
  }

  /** Определяет доступный тип подключения. */
  protected async resolveConnectionType(preferred?: ConnectionType): Promise<ConnectionType> {
    if (preferred) {
      if (await this.isConnectionAvailable(preferred)) return preferred;
    }
    if (await this.isConnectionAvailable('external')) return 'external';
    if (await this.isConnectionAvailable('internal')) return 'internal';
    throw new Error(
      IS_PRODUCTION
        ? 'Sigur не настроен. В production требуется внешний канал Sigur'
        : 'Sigur не настроен. Укажите параметры Sigur во временных настройках или в .env',
    );
  }

  /** Проверяет, настроено ли хотя бы одно подключение к Sigur. */
  async isConfigured(): Promise<boolean> {
    return (await this.isConnectionAvailable('external')) || (await this.isConnectionAvailable('internal'));
  }

  /**
   * Фоновые процессы всегда должны идти через внешний канал, если он настроен.
   * Во внутренний откатываемся только как в fallback для локальной/аварийной среды.
   */
  async getBackgroundConnectionType(): Promise<ConnectionType> {
    if (await this.isConnectionAvailable('external')) return 'external';
    if (await this.isConnectionAvailable('internal')) return 'internal';
    throw new Error(
      IS_PRODUCTION
        ? 'Sigur не настроен. В production требуется внешний канал Sigur'
        : 'Sigur не настроен. Укажите параметры Sigur во временных настройках или в .env',
    );
  }

  /** Возвращает информацию о доступных подключениях. */
  async getAvailableConnections(): Promise<{ external: boolean; internal: boolean }> {
    return {
      external: await this.isConnectionAvailable('external'),
      internal: await this.isConnectionAvailable('internal'),
    };
  }

  private createClient(config: SigurConnectionConfig): AxiosInstance {
    return axios.create({
      baseURL: config.url,
      timeout: SIGUR_TIMEOUTS.auth,
      httpsAgent: new https.Agent({
        rejectUnauthorized: false,
      }),
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  /** Авторизуется на сервере Sigur и получает токен. */
  async authenticate(connection?: ConnectionType): Promise<string> {
    const connType = await this.resolveConnectionType(connection);
    const config = await this.ensureFreshConnectionState(connType);

    const client = this.createClient(config);

    const response = await client.post('/api/v1/users/auth', {
      username: config.username,
      password: config.password,
    });

    const token = response.data?.token;
    const refreshToken = response.data?.refreshToken || '';
    const expiresAt = response.data?.expiresAt || '';

    if (!token) {
      throw new Error('Не удалось получить токен от Sigur. Проверьте логин/пароль.');
    }

    this.tokens[connType] = {
      token,
      refreshToken,
      expiresAt,
      authenticatedAt: Date.now(),
    };

    this.clients[connType] = axios.create({
      baseURL: config.url,
      timeout: SIGUR_TIMEOUTS.bulk,
      httpsAgent: new https.Agent({
        rejectUnauthorized: false,
      }),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
    });

    return token;
  }

  private async getClient(connection?: ConnectionType): Promise<AxiosInstance> {
    const connType = await this.resolveConnectionType(connection);
    await this.ensureFreshConnectionState(connType);

    if (!this.clients[connType] || !this.tokens[connType]) {
      await this.authenticate(connType);
    }

    return this.clients[connType]!;
  }

  private async refreshTokens(connection: ConnectionType): Promise<string> {
    const tokenInfo = this.tokens[connection];
    if (!tokenInfo?.refreshToken) {
      return this.authenticate(connection);
    }

    const config = await this.ensureFreshConnectionState(connection);
    try {
      const client = this.createClient(config);
      const response = await client.post('/api/v1/jwt/refresh', tokenInfo.refreshToken, {
        headers: {
          'Authorization': `Bearer ${tokenInfo.token}`,
          'Content-Type': 'text/plain',
        },
      });

      const newToken = response.data?.token;
      if (!newToken) {
        return this.authenticate(connection);
      }

      this.tokens[connection] = {
        token: newToken,
        refreshToken: response.data?.refreshToken || tokenInfo.refreshToken,
        expiresAt: response.data?.expiresAt || '',
        authenticatedAt: Date.now(),
      };

      this.clients[connection] = axios.create({
        baseURL: config.url,
        timeout: SIGUR_TIMEOUTS.bulk,
        httpsAgent: new https.Agent({ rejectUnauthorized: false }),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${newToken}`,
        },
      });

      return newToken;
    } catch {
      return this.authenticate(connection);
    }
  }

  invalidateConnectionState(connection?: ConnectionType): void {
    const connections: ConnectionType[] = connection ? [connection] : ['external', 'internal'];
    for (const connType of connections) {
      delete this.tokens[connType];
      delete this.clients[connType];
      delete this.connectionFingerprints[connType];
    }
  }

  private async sendRequest<T>(
    method: 'get' | 'post' | 'put' | 'patch' | 'delete',
    endpoint: string,
    options: {
      params?: Record<string, any>;
      data?: unknown;
      headers?: Record<string, string>;
      timeout?: number;
    } = {},
    connection?: ConnectionType,
  ): Promise<T> {
    if (!sigurLimiterLogged) {
      sigurLimiterLogged = true;
      console.log(`[sigur] request limiter initialized: concurrency=${SIGUR_MAX_CONCURRENCY}`);
    }

    const release = await sigurLimiter.acquire();
    try {
      return await this.sendRequestWithRetry<T>(method, endpoint, options, connection);
    } finally {
      release();
    }
  }

  private async sendRequestWithRetry<T>(
    method: 'get' | 'post' | 'put' | 'patch' | 'delete',
    endpoint: string,
    options: {
      params?: Record<string, any>;
      data?: unknown;
      headers?: Record<string, string>;
      timeout?: number;
    },
    connection?: ConnectionType,
  ): Promise<T> {
    const connType = await this.resolveConnectionType(connection);
    let client = await this.getClient(connType);
    let attempt = 0;
    let lastError: unknown;

    while (attempt <= SIGUR_RETRY_ATTEMPTS) {
      try {
        const response = await client.request<T>({
          method,
          url: endpoint,
          params: options.params,
          data: options.data,
          headers: options.headers,
          timeout: options.timeout,
        });
        return response.data;
      } catch (error) {
        lastError = error;

        if (error instanceof AxiosError && error.response?.status === 401) {
          await this.refreshTokens(connType);
          client = this.clients[connType]!;
          const response = await client.request<T>({
            method,
            url: endpoint,
            params: options.params,
            data: options.data,
            headers: options.headers,
            timeout: options.timeout,
          });
          return response.data;
        }

        if (attempt >= SIGUR_RETRY_ATTEMPTS || !this.isRetryableError(error)) {
          throw error;
        }

        const delay = SIGUR_RETRY_BASE_MS * Math.pow(2, attempt);
        const status = error instanceof AxiosError ? error.response?.status : undefined;
        const code = error instanceof AxiosError ? error.code : undefined;
        console.warn(
          `[sigur] retry ${attempt + 1}/${SIGUR_RETRY_ATTEMPTS} ${method.toUpperCase()} ${endpoint} after ${delay}ms (status=${status ?? '-'} code=${code ?? '-'})`,
        );
        await new Promise(resolve => setTimeout(resolve, delay));
        attempt++;
      }
    }

    throw lastError;
  }

  private isRetryableError(error: unknown): boolean {
    if (!(error instanceof AxiosError)) return false;
    if (error.response?.status && SIGUR_RETRY_STATUSES.has(error.response.status)) return true;
    if (error.code && SIGUR_RETRY_CODES.has(error.code)) return true;
    return false;
  }

  /** Выполняет GET-запрос с автоматической переавторизацией при 401. */
  protected async request<T>(
    endpoint: string,
    params?: Record<string, any>,
    connection?: ConnectionType,
    timeout?: number,
  ): Promise<T> {
    return this.sendRequest<T>('get', endpoint, { params, timeout }, connection);
  }

  protected async mutate<T>(
    method: 'post' | 'put' | 'patch' | 'delete',
    endpoint: string,
    body?: unknown,
    params?: Record<string, any>,
    connection?: ConnectionType,
    headers?: Record<string, string>,
    timeout?: number,
  ): Promise<T> {
    return this.sendRequest<T>(method, endpoint, {
      params,
      data: body,
      headers,
      timeout,
    }, connection);
  }

  /** Добавляет таймзону +03:00 если она отсутствует. */
  protected ensureTimezone(time: string): string {
    if (/[+-]\d{2}:\d{2}$/.test(time) || time.endsWith('Z')) return time;
    return `${time}+03:00`;
  }

  private extractCollectionItems<T>(response: unknown, endpoint: string): T[] {
    if (Array.isArray(response)) {
      return response as T[];
    }

    if (!response || typeof response !== 'object') {
      return [];
    }

    const record = response as Record<string, unknown>;
    const preferredKeys = ['data', 'items', 'content', 'results', 'rows', 'employees', 'departments'];

    for (const key of preferredKeys) {
      if (Array.isArray(record[key])) {
        return record[key] as T[];
      }
    }

    const firstArrayEntry = Object.entries(record).find(([, value]) => Array.isArray(value));
    if (firstArrayEntry) {
      console.warn(`[sigur paginate] ${endpoint} used fallback array key "${firstArrayEntry[0]}"`);
      return firstArrayEntry[1] as T[];
    }

    console.warn(
      `[sigur paginate] ${endpoint} returned non-array payload with keys: [${Object.keys(record).join(', ')}]`,
    );
    return [];
  }

  /** Пагинация с колбэком прогресса (для SSE). */
  async fetchWithProgress<T>(
    endpoint: string,
    onProgress: (loaded: number, page: number, pageItems: T[]) => void,
    params?: Record<string, any>,
    connection?: ConnectionType,
    pageSize = 1000,
  ): Promise<T[]> {
    const allItems: T[] = [];
    let offset = 0;
    let page = 0;

    while (true) {
      page++;
      const response = await this.request<any>(endpoint, {
        ...params,
        limit: pageSize,
        offset,
      }, connection);

      const items = this.extractCollectionItems<T>(response, endpoint);
      if (!Array.isArray(items) || items.length === 0) break;

      allItems.push(...items);
      onProgress(allItems.length, page, items);

      if (items.length < pageSize) break;
      offset += pageSize;
    }

    return allItems;
  }

  /** Итерационно забирает все записи с пагинацией. */
  async fetchAllPaginated<T>(endpoint: string, params?: Record<string, any>, connection?: ConnectionType, pageSize = PAGE_SIZE): Promise<T[]> {
    const allItems: T[] = [];
    let offset = 0;
    let page = 0;

    console.log(`[sigur paginate] start: ${endpoint} (pageSize=${pageSize})`, params);

    while (true) {
      page++;
      console.log(`[sigur paginate] page ${page}, offset ${offset}`);

      const response = await this.request<any>(endpoint, {
        ...params,
        limit: pageSize,
        offset,
      }, connection);

      const items = this.extractCollectionItems<T>(response, endpoint);
      console.log(`[sigur paginate] page ${page} got ${items.length} items`);

      if (items.length === 0) {
        break;
      }

      allItems.push(...items);

      if (items.length < pageSize) {
        break;
      }

      offset += pageSize;
    }

    console.log(`[sigur paginate] done: ${allItems.length} total items in ${page} pages`);
    return allItems;
  }

  /** Cursor-based пагинация через lastId (для events). */
  async fetchAllByLastId<T extends Record<string, any>>(
    endpoint: string,
    params?: Record<string, any>,
    connection?: ConnectionType,
    pageSize = PAGE_SIZE,
    idField: 'lastId' | 'lastLogId' = 'lastId',
  ): Promise<T[]> {
    const allItems: T[] = [];
    let lastId: number | undefined;
    let page = 0;

    console.log(`[sigur cursor] start: ${endpoint} (pageSize=${pageSize}, idField=${idField})`, params);

    while (true) {
      page++;
      const reqParams: Record<string, any> = { ...params, limit: pageSize };
      if (lastId != null) reqParams[idField] = lastId;

      console.log(`[sigur cursor] page ${page}, ${idField}=${lastId ?? 'none'}`);

      const response = await this.request<any>(endpoint, reqParams, connection);
      const items: T[] = response?.data || response || [];

      console.log(`[sigur cursor] page ${page} got ${Array.isArray(items) ? items.length : 'non-array'} items`);

      if (!Array.isArray(items) || items.length === 0) break;

      allItems.push(...items);

      // Извлекаем id последнего элемента для следующей страницы
      const last = items[items.length - 1];
      const nextId = typeof last.id === 'number' ? last.id : typeof last.logId === 'number' ? last.logId : undefined;

      if (nextId == null) {
        console.warn(`[sigur cursor] no id/logId in last item, stopping pagination`);
        break;
      }

      if (items.length < pageSize) break;
      lastId = nextId;
    }

    console.log(`[sigur cursor] done: ${allItems.length} total items in ${page} pages`);
    return allItems;
  }
}
