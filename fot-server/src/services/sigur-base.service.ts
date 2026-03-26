import axios, { AxiosInstance, AxiosError } from 'axios';
import https from 'https';
import { env } from '../config/env.js';

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

/**
 * Базовый сервис для взаимодействия с Sigur REST API.
 * Содержит ядро: авторизацию, запросы, пагинацию.
 */
export class SigurServiceBase {
  private tokens: Partial<Record<ConnectionType, SigurTokenInfo>> = {};
  private clients: Partial<Record<ConnectionType, AxiosInstance>> = {};

  private getConnectionConfig(type: ConnectionType): SigurConnectionConfig | null {
    if (type === 'external') {
      if (env.SIGUR_EXTERNAL_URL && env.SIGUR_EXTERNAL_USERNAME && env.SIGUR_EXTERNAL_PASSWORD) {
        return {
          url: env.SIGUR_EXTERNAL_URL,
          username: env.SIGUR_EXTERNAL_USERNAME,
          password: env.SIGUR_EXTERNAL_PASSWORD,
        };
      }
    } else {
      if (env.SIGUR_INTERNAL_URL && env.SIGUR_INTERNAL_USERNAME && env.SIGUR_INTERNAL_PASSWORD) {
        return {
          url: env.SIGUR_INTERNAL_URL,
          username: env.SIGUR_INTERNAL_USERNAME,
          password: env.SIGUR_INTERNAL_PASSWORD,
        };
      }
    }
    return null;
  }

  /** Определяет доступный тип подключения. */
  protected resolveConnectionType(preferred?: ConnectionType): ConnectionType {
    if (preferred) {
      const config = this.getConnectionConfig(preferred);
      if (config) return preferred;
    }
    if (this.getConnectionConfig('internal')) return 'internal';
    if (this.getConnectionConfig('external')) return 'external';
    throw new Error('Sigur не настроен. Укажите SIGUR_INTERNAL_* или SIGUR_EXTERNAL_* в .env');
  }

  /** Проверяет, настроено ли хотя бы одно подключение к Sigur. */
  isConfigured(): boolean {
    return !!(this.getConnectionConfig('external') || this.getConnectionConfig('internal'));
  }

  /** Возвращает информацию о доступных подключениях. */
  getAvailableConnections(): { external: boolean; internal: boolean } {
    return {
      external: !!this.getConnectionConfig('external'),
      internal: !!this.getConnectionConfig('internal'),
    };
  }

  private createClient(config: SigurConnectionConfig): AxiosInstance {
    return axios.create({
      baseURL: config.url,
      timeout: 120000,
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
    const connType = this.resolveConnectionType(connection);
    const config = this.getConnectionConfig(connType)!;

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
      timeout: 120000,
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
    const connType = this.resolveConnectionType(connection);

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

    const config = this.getConnectionConfig(connection)!;
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
        timeout: 120000,
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

  /** Выполняет GET-запрос с автоматической переавторизацией при 401. */
  protected async request<T>(endpoint: string, params?: Record<string, any>, connection?: ConnectionType): Promise<T> {
    const connType = this.resolveConnectionType(connection);
    let client = await this.getClient(connType);

    try {
      const response = await client.get<T>(endpoint, { params });
      return response.data;
    } catch (error) {
      if (error instanceof AxiosError && error.response?.status === 401) {
        await this.refreshTokens(connType);
        client = this.clients[connType]!;
        const response = await client.get<T>(endpoint, { params });
        return response.data;
      }
      throw error;
    }
  }

  /** Добавляет таймзону +03:00 если она отсутствует. */
  protected ensureTimezone(time: string): string {
    if (/[+-]\d{2}:\d{2}$/.test(time) || time.endsWith('Z')) return time;
    return `${time}+03:00`;
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

      const items = response?.data || response || [];
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

      const items = response?.data || response || [];
      console.log(`[sigur paginate] page ${page} got ${Array.isArray(items) ? items.length : 'non-array'} items`);

      if (!Array.isArray(items) || items.length === 0) {
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
