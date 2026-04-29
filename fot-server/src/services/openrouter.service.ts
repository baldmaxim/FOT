import axios, { AxiosError } from 'axios';
import { settingsService, ALLOWED_OPENROUTER_MODELS, isAllowedOpenRouterModel } from './settings.service.js';

const TIMEOUT_MS = 60_000;
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const RETRY_CODES = new Set(['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EAI_AGAIN']);
const RETRY_ATTEMPTS = 3;
const RETRY_BASE_MS = 800;

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
}

export interface IChatCompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /** Стоимость в USD, OpenRouter присылает в поле cost (если генерация идёт через их прокси) */
  cost?: number;
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
   * Можно переопределить через opts.modelOverride (только из white-list).
   */
  async chatCompletion(
    payload: IChatCompletionRequest,
    opts?: { modelOverride?: string },
  ): Promise<IChatCompletionResponse & { resolvedModel: string }> {
    const config = await settingsService.getResolvedOpenRouterConfig();
    if (!config) {
      throw new Error('OpenRouter не настроен (нет API key или выключен)');
    }

    let model = config.model;
    if (opts?.modelOverride) {
      if (!isAllowedOpenRouterModel(opts.modelOverride)) {
        throw new Error(`Модель "${opts.modelOverride}" не входит в список разрешённых`);
      }
      model = opts.modelOverride;
    }

    const url = `${config.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const headers = {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.PUBLIC_URL || 'https://fot.local',
      'X-Title': 'FOT Patent Receipts OCR',
    };

    const body = { model, ...payload };

    let lastErr: unknown;
    for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
      try {
        const res = await axios.post<IChatCompletionResponse>(url, body, {
          headers,
          timeout: TIMEOUT_MS,
        });
        return { ...res.data, resolvedModel: model };
      } catch (err) {
        lastErr = err;
        const axErr = err as AxiosError;
        if (attempt < RETRY_ATTEMPTS && isRetryable(axErr)) {
          const delay = RETRY_BASE_MS * 2 ** (attempt - 1);
          console.warn(`[openrouter] retry ${attempt}/${RETRY_ATTEMPTS} after ${delay}ms (${axErr.response?.status || axErr.code})`);
          await sleep(delay);
          continue;
        }
        const status = axErr.response?.status;
        const data = axErr.response?.data as unknown;
        const msg = (data && typeof data === 'object' && 'error' in data && (data as { error: { message?: string } }).error?.message)
          || axErr.message
          || 'OpenRouter request failed';
        throw new Error(`OpenRouter error${status ? ` ${status}` : ''}: ${msg}`);
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
