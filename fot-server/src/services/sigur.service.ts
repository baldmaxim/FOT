import axios, { AxiosInstance, AxiosError } from 'axios';
import https from 'https';
import { env } from '../config/env.js';

type ConnectionType = 'external' | 'internal';

interface SigurConnectionConfig {
  url: string;
  username: string;
  password: string;
}

interface SigurTokenInfo {
  token: string;
  authenticatedAt: number;
}

const PAGE_SIZE = 100;

/**
 * Сервис для взаимодействия с Sigur REST API.
 * Поддерживает два подключения: external (для разработки) и internal (локальная сеть).
 */
class SigurService {
  private tokens: Partial<Record<ConnectionType, SigurTokenInfo>> = {};
  private clients: Partial<Record<ConnectionType, AxiosInstance>> = {};
  private employeeCache: { data: Record<string, unknown>[]; fetchedAt: number } | null = null;
  private employeeFetchPromise: Promise<Record<string, unknown>[]> | null = null;
  private departmentCache: { map: Map<number, string>; fetchedAt: number } | null = null;
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 минут

  /**
   * Возвращает конфигурацию подключения по типу, если все переменные заданы.
   */
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

  /**
   * Определяет доступный тип подключения.
   * Приоритет: переданный параметр → internal → external.
   */
  private resolveConnection(preferred?: ConnectionType): ConnectionType {
    if (preferred) {
      const config = this.getConnectionConfig(preferred);
      if (config) return preferred;
    }
    if (this.getConnectionConfig('internal')) return 'internal';
    if (this.getConnectionConfig('external')) return 'external';
    throw new Error('Sigur не настроен. Укажите SIGUR_INTERNAL_* или SIGUR_EXTERNAL_* в .env');
  }

  /**
   * Проверяет, настроено ли хотя бы одно подключение к Sigur.
   */
  isConfigured(): boolean {
    return !!(this.getConnectionConfig('external') || this.getConnectionConfig('internal'));
  }

  /**
   * Возвращает информацию о доступных подключениях.
   */
  getAvailableConnections(): { external: boolean; internal: boolean } {
    return {
      external: !!this.getConnectionConfig('external'),
      internal: !!this.getConnectionConfig('internal'),
    };
  }

  /**
   * Создаёт axios-инстанс для указанного подключения.
   */
  private createClient(config: SigurConnectionConfig): AxiosInstance {
    return axios.create({
      baseURL: config.url,
      timeout: 120000,
      httpsAgent: new https.Agent({
        rejectUnauthorized: false, // self-signed сертификаты Sigur
      }),
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * Авторизуется на сервере Sigur и получает токен.
   */
  async authenticate(connection?: ConnectionType): Promise<string> {
    const connType = this.resolveConnection(connection);
    const config = this.getConnectionConfig(connType)!;

    const client = this.createClient(config);

    const response = await client.post('/api/v1/users/auth', {
      username: config.username,
      password: config.password,
    });

    const token = response.data?.token || response.data?.data?.token;

    if (!token) {
      throw new Error('Не удалось получить токен от Sigur. Проверьте логин/пароль.');
    }

    this.tokens[connType] = {
      token,
      authenticatedAt: Date.now(),
    };

    // Создаём клиент с токеном
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

  /**
   * Возвращает авторизованный axios-клиент, при необходимости аутентифицируясь.
   */
  private async getClient(connection?: ConnectionType): Promise<AxiosInstance> {
    const connType = this.resolveConnection(connection);

    if (!this.clients[connType] || !this.tokens[connType]) {
      await this.authenticate(connType);
    }

    return this.clients[connType]!;
  }

  /**
   * Выполняет GET-запрос с автоматической переавторизацией при 401.
   */
  private async request<T>(endpoint: string, params?: Record<string, any>, connection?: ConnectionType): Promise<T> {
    const connType = this.resolveConnection(connection);
    let client = await this.getClient(connType);

    try {
      const response = await client.get<T>(endpoint, { params });
      return response.data;
    } catch (error) {
      if (error instanceof AxiosError && error.response?.status === 401) {
        // Токен истёк — переавторизуемся
        await this.authenticate(connType);
        client = this.clients[connType]!;
        const response = await client.get<T>(endpoint, { params });
        return response.data;
      }
      throw error;
    }
  }

  /**
   * Итерационно забирает все записи с пагинацией.
   */
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

  // --- Методы получения данных ---

  /** Проверка подключения к Sigur */
  async testConnection(connection?: ConnectionType): Promise<{ success: boolean; message: string; connection: ConnectionType }> {
    const connType = this.resolveConnection(connection);
    try {
      await this.authenticate(connType);
      // Пробуем получить список отделов как тестовый запрос
      await this.request('/api/v1/departments', { limit: 1 }, connType);
      return { success: true, message: 'Подключение к Sigur успешно', connection: connType };
    } catch (error) {
      const message = error instanceof AxiosError
        ? `Ошибка подключения: ${error.message}${error.response?.data ? ' — ' + JSON.stringify(error.response.data) : ''}`
        : `Ошибка: ${(error as Error).message}`;
      return { success: false, message, connection: connType };
    }
  }

  /** Получить список сотрудников */
  async getEmployees(filters?: Record<string, any>, connection?: ConnectionType) {
    return this.fetchAllPaginated('/api/v1/employees', filters, connection);
  }

  /** Получить сотрудников одним запросом (для preview) */
  async getEmployeesLimited(maxItems = 5000, connection?: ConnectionType) {
    const response = await this.request<any>('/api/v1/employees', { limit: maxItems }, connection);
    const items = response?.data || response || [];
    return Array.isArray(items) ? items : [];
  }

  /** Получить сотрудников с кэшем (TTL 5 мин, дедупликация запросов) */
  async getEmployeesCached(connection?: ConnectionType): Promise<Record<string, unknown>[]> {
    if (this.employeeCache && (Date.now() - this.employeeCache.fetchedAt) < this.CACHE_TTL) {
      return this.employeeCache.data;
    }
    // Если fetch уже идёт — ждём его завершения
    if (this.employeeFetchPromise) {
      console.log('[sigur] waiting for ongoing employee fetch...');
      return this.employeeFetchPromise;
    }
    console.log('[sigur] fetching employees (no cache)...');
    this.employeeFetchPromise = this.getEmployeesLimited(5000, connection)
      .then(data => {
        this.employeeCache = { data, fetchedAt: Date.now() };
        console.log('[sigur] cached', data.length, 'employees');
        return data;
      })
      .finally(() => {
        this.employeeFetchPromise = null;
      });
    return this.employeeFetchPromise;
  }

  /** Получить справочник отделов с кэшем: departmentId → name */
  async getDepartmentMapCached(connection?: ConnectionType): Promise<Map<number, string>> {
    if (this.departmentCache && (Date.now() - this.departmentCache.fetchedAt) < this.CACHE_TTL) {
      return this.departmentCache.map;
    }
    console.log('[sigur] fetching departments for cache...');
    const response = await this.request<any>('/api/v1/departments', { limit: 500 }, connection);
    const items = response?.data || response || [];
    const map = new Map<number, string>();
    if (Array.isArray(items)) {
      for (const dept of items) {
        if (typeof dept.id === 'number' && typeof dept.name === 'string') {
          map.set(dept.id, dept.name);
        }
      }
    }
    this.departmentCache = { map, fetchedAt: Date.now() };
    console.log('[sigur] cached', map.size, 'departments');
    return map;
  }

  /** Получить список отделов */
  async getDepartments(connection?: ConnectionType) {
    return this.fetchAllPaginated('/api/v1/departments', undefined, connection);
  }

  /** Получить список карт доступа */
  async getCards(filters?: Record<string, any>, connection?: ConnectionType) {
    return this.fetchAllPaginated('/api/v1/cards', filters, connection);
  }

  /** Получить список точек доступа */
  async getAccessPoints(connection?: ConnectionType) {
    return this.fetchAllPaginated('/api/v1/accesspoints', undefined, connection);
  }

  /** Получить список режимов доступа */
  async getAccessRules(connection?: ConnectionType) {
    return this.fetchAllPaginated('/api/v1/accessrules', undefined, connection);
  }

  /** Получить список зон доступа */
  async getZones(connection?: ConnectionType) {
    return this.fetchAllPaginated('/api/v1/zones', undefined, connection);
  }

  /**
   * Добавляет таймзону +03:00 если она отсутствует.
   * Sigur API игнорирует startTime/endTime без таймзоны.
   */
  private ensureTimezone(time: string): string {
    if (/[+-]\d{2}:\d{2}$/.test(time) || time.endsWith('Z')) return time;
    return `${time}+03:00`;
  }

  /** Получить события (расширенные) с фильтрами по времени */
  async getEvents(startTime?: string, endTime?: string, connection?: ConnectionType, eventType?: string) {
    const params: Record<string, any> = {};
    if (startTime) params.startTime = this.ensureTimezone(startTime);
    if (endTime) params.endTime = this.ensureTimezone(endTime);
    if (eventType) params.eventType = eventType;
    return this.fetchAllPaginated('/api/v1/events/parsed', params, connection, 1000);
  }

  /** Получить ограниченное кол-во событий (для preview) */
  async getEventsLimited(startTime?: string, endTime?: string, maxItems = 200, connection?: ConnectionType) {
    const params: Record<string, any> = { limit: maxItems };
    if (startTime) params.startTime = this.ensureTimezone(startTime);
    if (endTime) params.endTime = this.ensureTimezone(endTime);
    const response = await this.request<any>('/api/v1/events/parsed', params, connection);
    const items = response?.data || response || [];
    return Array.isArray(items) ? items.slice(0, maxItems) : [];
  }

  /** Получить коды событий */
  async getEventCodes(connection?: ConnectionType) {
    return this.request('/api/v1/events/codes', undefined, connection);
  }

  /** Предзагрузка кэша сотрудников при старте сервера */
  warmUpCache(): void {
    if (!this.isConfigured()) return;
    console.log('[sigur] warming up employee cache...');
    this.getEmployeesCached().catch(e =>
      console.warn('[sigur] cache warmup failed:', (e as Error).message),
    );
  }
}

export const sigurService = new SigurService();

// Предзагрузка кэша при импорте модуля (старт сервера)
sigurService.warmUpCache();
