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
      timeout: 30000,
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
      timeout: 30000,
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
  async fetchAllPaginated<T>(endpoint: string, params?: Record<string, any>, connection?: ConnectionType): Promise<T[]> {
    const allItems: T[] = [];
    let offset = 0;

    while (true) {
      const response = await this.request<any>(endpoint, {
        ...params,
        limit: PAGE_SIZE,
        offset,
      }, connection);

      const items = response?.data || response || [];

      if (!Array.isArray(items) || items.length === 0) {
        break;
      }

      allItems.push(...items);

      if (items.length < PAGE_SIZE) {
        break;
      }

      offset += PAGE_SIZE;
    }

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

  /** Получить события (расширенные) с фильтрами по времени */
  async getEvents(startTime?: string, endTime?: string, connection?: ConnectionType) {
    const params: Record<string, any> = {};
    if (startTime) params.startTime = startTime;
    if (endTime) params.endTime = endTime;
    return this.fetchAllPaginated('/api/v1/events/parsed', params, connection);
  }

  /** Получить коды событий */
  async getEventCodes(connection?: ConnectionType) {
    return this.request('/api/v1/events/codes', undefined, connection);
  }
}

export const sigurService = new SigurService();
