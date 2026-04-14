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

  return configured || 'http://localhost:3000/api';
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

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

interface RequestOptions extends RequestInit {
  skipAuth?: boolean;
  __skipRefresh?: boolean;
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
    const { skipAuth, __skipRefresh, ...fetchOptions } = options;

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

    const response = await fetch(buildApiUrl(endpoint), {
      ...fetchOptions,
      credentials: 'include',
      headers,
    });

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
      throw new ApiError(
        error.error || error.message || 'Произошла ошибка',
        response.status,
        error.code
      );
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
