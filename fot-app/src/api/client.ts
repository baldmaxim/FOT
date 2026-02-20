const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000/api';

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
}

export const apiClient = {
  async request<T>(endpoint: string, options: RequestOptions = {}): Promise<T> {
    const { skipAuth, ...fetchOptions } = options;
    const token = localStorage.getItem('access_token');

    const headers: HeadersInit = {
      ...fetchOptions.headers,
    };

    // Add Content-Type for JSON requests (not for FormData)
    if (!(fetchOptions.body instanceof FormData)) {
      (headers as Record<string, string>)['Content-Type'] = 'application/json';
    }

    // Add Authorization header if token exists and not skipped
    if (token && !skipAuth) {
      (headers as Record<string, string>)['Authorization'] = `Bearer ${token}`;
    }

    const response = await fetch(`${API_URL}${endpoint}`, {
      ...fetchOptions,
      headers,
    });

    // Handle 401 - authentication error
    if (response.status === 401) {
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
      const error = await response.json().catch(() => ({ message: 'Ошибка сервера' }));
      throw new ApiError(
        error.message || error.error || 'Произошла ошибка',
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
