import axios, { AxiosError } from 'axios';
import { settingsService, ALLOWED_OPENROUTER_MODELS, isKnownOpenRouterModel } from './settings.service.js';

const TIMEOUT_MS = 60_000;
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const RETRY_CODES = new Set(['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EAI_AGAIN']);
const RETRY_ATTEMPTS = 3;
const RETRY_BASE_MS = 800;
const RETRY_429_BASE_MS = 4_000;
const RETRY_MAX_MS = 30_000;

export class OpenRouterError extends Error {
  status: number | null;
  retryAfterSec: number | null;
  /** Сырое тело ответа OpenRouter (усечённое) — реальная причина 4xx для Sentry. */
  body: string | null;
  constructor(message: string, status: number | null, retryAfterSec: number | null = null, body: string | null = null) {
    super(message);
    this.name = 'OpenRouterError';
    this.status = status;
    this.retryAfterSec = retryAfterSec;
    this.body = body;
  }
}

const parseRetryAfter = (header: unknown): number | null => {
  if (typeof header !== 'string') return null;
  const trimmed = header.trim();
  if (!trimmed) return null;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 60);
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    const diff = Math.ceil((dateMs - Date.now()) / 1000);
    return diff > 0 ? Math.min(diff, 60) : 0;
  }
  return null;
};

export interface IChatMessageContentText {
  type: 'text';
  text: string;
}

export interface IChatMessageContentImage {
  type: 'image_url';
  image_url: { url: string };
}

export type ChatMessageContent = IChatMessageContentText | IChatMessageContentImage;

export interface IChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ChatMessageContent[];
}

export interface IChatCompletionRequest {
  messages: IChatMessage[];
  response_format?: {
    type: 'json_schema' | 'json_object';
    json_schema?: { name: string; strict?: boolean; schema: object };
  };
  temperature?: number;
  max_tokens?: number;
  seed?: number;
  reasoning?: { effort: 'low' | 'medium' | 'high' };
  /** OpenRouter provider routing (data_collection/zdr/fallbacks). */
  provider?: {
    data_collection?: 'deny' | 'allow';
    zdr?: boolean;
    require_parameters?: boolean;
    allow_fallbacks?: boolean;
  };
}

export interface IChatCompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /** Стоимость в USD, OpenRouter присылает в поле cost (если генерация идёт через их прокси) */
  cost?: number;
  /** Разбивка prompt-токенов; cached_tokens — сколько пришло из prefix-кэша провайдера. */
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
}

export interface IChatCompletionResponse {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    message: { role: 'assistant'; content: string | null };
    finish_reason: string;
  }>;
  usage?: IChatCompletionUsage;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

const isRetryable = (err: AxiosError): boolean => {
  if (err.response?.status && RETRY_STATUSES.has(err.response.status)) return true;
  if (err.code && RETRY_CODES.has(err.code)) return true;
  return false;
};

export const openRouterService = {
  /**
   * Список моделей, разрешённых для распознавания.
   * Используется в UI настроек.
   */
  getAllowedModels() {
    return ALLOWED_OPENROUTER_MODELS;
  },

  /**
   * Выполнить chat completion. Модель берётся из system_settings.
   * Можно переопределить через opts.modelOverride (только из каталога моделей).
   *
   * opts.configOverride — ключ/baseUrl вместо глобального OCR-конфига
   * (адаптивное тестирование резолвит и валидирует свой конфиг само).
   * opts.maxAttempts — СУММАРНОЕ число HTTP-попыток (не «ретраев сверх
   * первой»); по умолчанию RETRY_ATTEMPTS.
   */
  async chatCompletion(
    payload: IChatCompletionRequest,
    opts?: {
      modelOverride?: string;
      configOverride?: { apiKey: string; baseUrl: string };
      title?: string;
      maxAttempts?: number;
    },
  ): Promise<IChatCompletionResponse & { resolvedModel: string }> {
    let apiKey: string;
    let baseUrl: string;
    let model: string | undefined;

    if (opts?.configOverride) {
      apiKey = opts.configOverride.apiKey;
      baseUrl = opts.configOverride.baseUrl;
    } else {
      const config = await settingsService.getResolvedOpenRouterConfig();
      if (!config) {
        throw new Error('OpenRouter не настроен (нет API key или выключен)');
      }
      apiKey = config.apiKey;
      baseUrl = config.baseUrl;
      model = config.model;
    }

    if (opts?.modelOverride) {
      if (!isKnownOpenRouterModel(opts.modelOverride)) {
        throw new Error(`Модель "${opts.modelOverride}" не входит в список разрешённых`);
      }
      model = opts.modelOverride;
    }
    if (!model) {
      throw new Error('Модель OpenRouter не задана');
    }

    const maxAttempts = Math.max(1, Math.min(opts?.maxAttempts ?? RETRY_ATTEMPTS, RETRY_ATTEMPTS));

    const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.PUBLIC_URL || 'https://fot.local',
      'X-Title': opts?.title || 'FOT Patent Receipts OCR',
    };

    const body = { model, ...payload };

    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await axios.post<IChatCompletionResponse>(url, body, {
          headers,
          timeout: TIMEOUT_MS,
          // Redirect от шлюза = ошибка (anti-SSRF: не уходим с доверенного URL).
          maxRedirects: 0,
        });
        return { ...res.data, resolvedModel: model };
      } catch (err) {
        lastErr = err;
        const axErr = err as AxiosError;
        if (attempt < maxAttempts && isRetryable(axErr)) {
          const status = axErr.response?.status;
          const retryAfter = parseRetryAfter(axErr.response?.headers?.['retry-after']);
          let delay: number;
          if (status === 429) {
            const base = retryAfter !== null ? retryAfter * 1000 : RETRY_429_BASE_MS * 2 ** (attempt - 1);
            delay = Math.min(base, RETRY_MAX_MS);
          } else {
            delay = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS);
          }
          console.warn(`[openrouter] retry ${attempt}/${maxAttempts} after ${delay}ms (${status || axErr.code}${retryAfter !== null ? `, retry-after=${retryAfter}s` : ''})`);
          await sleep(delay);
          continue;
        }
        const status = axErr.response?.status ?? null;
        const retryAfter = parseRetryAfter(axErr.response?.headers?.['retry-after']);
        const data = axErr.response?.data as unknown;
        const msg = (data && typeof data === 'object' && 'error' in data && (data as { error: { message?: string } }).error?.message)
          || axErr.message
          || 'OpenRouter request failed';
        // Тело ответа целиком (усечённое) — при 403/иных 4xx без error.message
        // это единственный способ увидеть настоящую причину (data-policy, ключ и т.п.).
        let body: string | null = null;
        if (data != null) {
          try {
            body = (typeof data === 'string' ? data : JSON.stringify(data)).slice(0, 600);
          } catch {
            body = null;
          }
        }
        throw new OpenRouterError(`OpenRouter error${status ? ` ${status}` : ''}: ${msg}`, status, retryAfter, body);
      }
    }

    throw lastErr instanceof Error ? lastErr : new Error('OpenRouter request failed');
  },

  /**
   * Минимальный health-check: пробуем дешёвый chat completion на текущей модели.
   * Возвращает true если ключ валиден и модель доступна.
   */
  async healthCheck(): Promise<{ ok: boolean; model?: string; error?: string }> {
    try {
      const res = await this.chatCompletion({
        messages: [
          { role: 'system', content: 'Reply with single character "1".' },
          { role: 'user', content: 'ping' },
        ],
        max_tokens: 4,
        temperature: 0,
      });
      return { ok: true, model: res.resolvedModel };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'unknown error' };
    }
  },
};
