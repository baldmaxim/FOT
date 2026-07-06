import * as Sentry from '@sentry/react';

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, '');
const isLocalHostname = (hostname: string): boolean =>
  hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';

const resolveApiUrl = (): string => {
  const configured = trimTrailingSlash(import.meta.env.VITE_API_URL || '');

  if (typeof window !== 'undefined') {
    const sameOriginApiUrl = `${window.location.origin}/api`;

    if (!configured) {
      return sameOriginApiUrl;
    }

    try {
      const resolved = new URL(configured, window.location.origin);
      const sameHost = resolved.hostname === window.location.hostname;
      const samePathFamily = resolved.pathname === '/api' || resolved.pathname.startsWith('/api/');
      const shouldKeepExplicitDevUrl = import.meta.env.DEV || isLocalHostname(window.location.hostname);

      // When the bundle is opened on the same host but the configured API points
      // to a different scheme or port, prefer the page origin to avoid CORS/cookie
      // breakage caused by cross-origin redirects.
      if (sameHost && samePathFamily && resolved.origin !== window.location.origin && !shouldKeepExplicitDevUrl) {
        return `${window.location.origin}${resolved.pathname}`;
      }

      return trimTrailingSlash(resolved.toString());
    } catch {
      return configured;
    }
  }

  return configured || 'http://localhost:3001/api';
};

export const API_URL = resolveApiUrl();
export const API_ORIGIN = typeof window !== 'undefined'
  ? new URL(API_URL, window.location.origin).origin
  : new URL(API_URL).origin;

let sessionToken: string | null = null;
let refreshPromise: Promise<boolean> | null = null;
const tokenListeners = new Set<(token: string | null) => void>();

export class ApiError extends Error {
  status: number;
  code?: string;
  details?: Record<string, unknown>;

  constructor(message: string, status: number, code?: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// Без таймаута fetch может висеть бесконечно на мобильных сетях (переключение
// 4G/Wi-Fi, слабый сигнал) — основной источник FOT-APP-1X «Failed to fetch».
// AbortController обрывает запрос, React Query (retry) повторяет.
const DEFAULT_TIMEOUT_MS = 30_000;

interface RequestOptions extends RequestInit {
  skipAuth?: boolean;
  __skipRefresh?: boolean;
  /** Таймаут запроса в мс; 0 — отключить. По умолчанию DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number;
}

export const setSessionToken = (token: string | null): void => {
  sessionToken = token;
  tokenListeners.forEach(listener => listener(token));
};

export const getSessionToken = (): string | null => sessionToken;

export const subscribeSessionToken = (listener: (token: string | null) => void): (() => void) => {
  tokenListeners.add(listener);
  return () => {
    tokenListeners.delete(listener);
  };
};

export const buildApiUrl = (endpoint: string): string => `${API_URL}${endpoint}`;

export const buildAuthHeaders = (headers: HeadersInit = {}): HeadersInit => {
  if (!sessionToken) return headers;
  return {
    ...headers,
    Authorization: `Bearer ${sessionToken}`,
  };
};

const shouldBypassHttpCache = (endpoint: string, method = 'GET'): boolean => {
  if (method.toUpperCase() !== 'GET') return false;
  const path = endpoint.split('?')[0];
  return path === '/skud/presence'
    || path === '/skud/dashboard-stats'
    || path === '/sigur/monitor/status'
    || path === '/sigur/monitor/checks'
    || path === '/sigur/monitor/incidents'
    // Списки согласований: после утверждения/отклонения refetch должен идти
    // на сервер за свежими данными, иначе браузер 30 сек отдаёт устаревший
    // список из HTTP-кэша (Cache-Control: max-age=30 на всех GET /api/*).
    || path === '/correction-approvals/pending-by-department'
    || path === '/correction-approvals/history-by-department'
    || path === '/correction-approvals/all-by-responsible'
    || path === '/timesheet-approvals/review-list'
    // Заявления: после создания/отмены/одобрения юзер ждёт мгновенного
    // обновления списка. Браузерный max-age=30 ловил все эти случаи —
    // карточка не появлялась/не пропадала до перезагрузки страницы.
    || path === '/leave-requests/my'
    || path === '/leave-requests/department'
    || path === '/leave-requests'
    || path === '/leave-requests/pending-count'
    // История назначений сотрудника: после DELETE/PATCH (блок «История назначений»
    // в модалке «График работы») refetch должен идти на сервер. Иначе кэш 30с
    // отдавал старый список — удалённая строка визуально оставалась, а вторая
    // попытка удалить её получала 404 «Назначение не найдено».
    || /^\/schedules\/employee\/\d+\/history$/.test(path)
    // Активные назначения для списка «Управление кадрами»: после
    // PUT/PATCH/DELETE «График работы» в модалке refetch должен подтянуть
    // свежие данные, иначе новые назначения визуально не появлялись /
    // изменённая дата не обновлялась до принудительного reload.
    || path === '/schedules/employees'
    // Список сотрудников «Управление кадрами»: после увольнения /
    // восстановления / отмены увольнения / создания / обновления HTTP-кэш
    // max-age=30 удерживал старое тело — уволенный сотрудник оставался в
    // активном списке до Ctrl+F5, хотя React Query уже инвалидировал
    // ['employees']. Карточка `/employees/:id` сюда не попадает (свой ETag/304).
    || path === '/employees'
    || path === '/employees/counts'
    // Месячный табель сотрудника / общий табель: после подачи корректировки
    // (time_correction) сам календарь личного кабинета должен показать новые
    // часы/бейдж заявки сразу. Иначе HTTP-кэш 30 сек отдавал старый body
    // /timesheet?... и юзеру приходилось обновлять страницу.
    || path === '/timesheet'
    // Личный кабинет подрядчика: после вписания/смены ФИО, сохранения или
    // ОЧИСТКИ документов держателя (паспорт/патент), добавления/удаления людей
    // и отправки заявки список должен обновиться сразу. Иначе HTTP-кэш max-age=30
    // удерживал старое тело: зелёная галочка «Документы» не пропадала после
    // очистки данных до перезагрузки страницы (≈30–60 сек).
    || path === '/contractor/passes'
    || path === '/contractor/roster'
    || path === '/contractor/submissions'
    // Общий пул подрядчика: после добавления/удаления/выпуска пропусков матрица и
    // панель аномалий должны обновиться сразу. Иначе HTTP-кэш max-age=30 отдавал
    // старую матрицу — добавленная карта не появлялась (и удалённая не исчезала)
    // до перезагрузки страницы, хотя React Query уже инвалидировал ['contractor-pool-*'].
    || path === '/admin/contractor/pool/matrix'
    || path === '/admin/contractor/pool/anomalies'
    // МТС Бизнес: статус фонового «Обновить всё» опрашивается каждые 3с, журнал
    // заявок персданных — каждые 15с; браузерный max-age=30 ломал бы polling.
    || path === '/mts-business/refresh-all/status'
    || path === '/mts-business/personal-data/requests';
};

const refreshSession = async (): Promise<boolean> => {
  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    const response = await fetch(buildApiUrl('/auth/refresh'), {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      setSessionToken(null);
      return false;
    }

    const contentType = response.headers.get('content-type');
    if (contentType?.includes('application/json')) {
      const payload = await response.json().catch(() => null) as { access_token?: string } | null;
      setSessionToken(payload?.access_token ?? null);
    } else {
      setSessionToken(null);
    }

    return true;
  })().finally(() => {
    refreshPromise = null;
  });

  return refreshPromise;
};

export const apiClient = {
  async request<T>(endpoint: string, options: RequestOptions = {}): Promise<T> {
    const { skipAuth, __skipRefresh, timeoutMs, ...fetchOptions } = options;

    const headers: HeadersInit = {
      ...fetchOptions.headers,
    };

    // Add Content-Type for JSON requests (not for FormData)
    if (!(fetchOptions.body instanceof FormData)) {
      (headers as Record<string, string>)['Content-Type'] = 'application/json';
    }

    // Add Authorization header if token exists and not skipped
    if (!skipAuth && sessionToken) {
      (headers as Record<string, string>)['Authorization'] = `Bearer ${sessionToken}`;
    }

    const method = (fetchOptions.method ?? 'GET').toUpperCase();
    const bypassHttpCache = shouldBypassHttpCache(endpoint, method);
    if (bypassHttpCache) {
      (headers as Record<string, string>)['Cache-Control'] = 'no-cache';
      (headers as Record<string, string>)['Pragma'] = 'no-cache';
    }

    // Таймаут через AbortController, скомпонованный с пользовательским signal
    // (React Query отмены продолжают работать как раньше).
    const controller = new AbortController();
    const callerSignal = fetchOptions.signal;
    if (callerSignal) {
      if (callerSignal.aborted) controller.abort();
      else callerSignal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    const effectiveTimeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let timedOut = false;
    const timer = effectiveTimeout > 0
      ? setTimeout(() => { timedOut = true; controller.abort(); }, effectiveTimeout)
      : null;

    let response: Response;
    try {
      response = await fetch(buildApiUrl(endpoint), {
        ...fetchOptions,
        cache: bypassHttpCache ? 'no-store' : fetchOptions.cache,
        credentials: 'include',
        headers,
        signal: controller.signal,
      });
    } catch (err) {
      // Наш таймаут — типизированная ApiError (useStructure её не шлёт в Sentry).
      // Иначе — отмена вызывающим (AbortError) или сетевой TypeError: пробрасываем как есть.
      if (timedOut) {
        throw new ApiError('Превышено время ожидания запроса (timeout)', 0, 'TIMEOUT');
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }

    // Handle 401 - authentication error
    if (response.status === 401) {
      if (!skipAuth && !__skipRefresh && endpoint !== '/auth/refresh') {
        const refreshed = await refreshSession();
        if (refreshed) {
          return this.request<T>(endpoint, { ...options, __skipRefresh: true });
        }
      }

      const error = await response.json().catch(() => ({ message: 'Ошибка аутентификации', error: 'Unknown' }));

      // Не удаляем токены и не редиректим автоматически
      // Пусть компонент сам решит что делать с ошибкой
      throw new ApiError(
        error.message || error.error || 'Сессия истекла',
        401,
        error.code || 'AUTH_ERROR'
      );
    }

    // Handle other errors
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Ошибка сервера' }));
      const apiError = new ApiError(
        error.error || error.message || 'Произошла ошибка',
        response.status,
        error.code,
        error,
      );
      // 5xx и сетевые сбои — серверная сторона; в Sentry с тегами для фильтрации.
      // 4xx (валидация, права) — ожидаемое поведение, не шумим.
      if (response.status >= 500) {
        Sentry.captureException(apiError, {
          tags: {
            endpoint,
            method: (fetchOptions.method ?? 'GET').toUpperCase(),
            status: String(response.status),
          },
        });
      }
      throw apiError;
    }

    // Handle empty response
    const contentType = response.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
      return {} as T;
    }

    return response.json();
  },

  get<T>(endpoint: string, options?: RequestOptions): Promise<T> {
    return this.request<T>(endpoint, { ...options, method: 'GET' });
  },

  post<T>(endpoint: string, body?: unknown, options?: RequestOptions): Promise<T> {
    const fetchOptions: RequestOptions = { ...options, method: 'POST' };

    if (body instanceof FormData) {
      fetchOptions.body = body;
    } else if (body !== undefined) {
      fetchOptions.body = JSON.stringify(body);
    }

    return this.request<T>(endpoint, fetchOptions);
  },

  put<T>(endpoint: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>(endpoint, {
      ...options,
      method: 'PUT',
      body: body ? JSON.stringify(body) : undefined,
    });
  },

  patch<T>(endpoint: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>(endpoint, {
      ...options,
      method: 'PATCH',
      body: body ? JSON.stringify(body) : undefined,
    });
  },

  delete<T>(endpoint: string, options?: RequestOptions): Promise<T> {
    return this.request<T>(endpoint, { ...options, method: 'DELETE' });
  },
};
