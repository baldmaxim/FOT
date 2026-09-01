/**
 * Вызов vision-модели для одного скана. Порт recognizeDocument из PassDesk
 * ocrService.js: payload (temperature 0.1, json_object), попытки strict-json →
 * loose-json, identifier-fallback для ИНН/СНИЛС, quality gate. Транспорт —
 * openRouterService (ретраи 429/5xx внутри него).
 *
 * В логи — только тип, попытка, модель, usage и код ошибки. Никаких значений полей.
 */
import type { HrOcrType } from '../../config/hr-documents.js';
import { openRouterService, OpenRouterError, type IChatMessage } from '../openrouter.service.js';
import { resolveFallbackPrompt, resolvePrompt, SYSTEM_PROMPT } from './prompts.js';
import {
  hasMeaningfulNormalizedData,
  mergeMissingNormalizedFields,
  normalizeResponseByType,
  parseStructuredJson,
  passesQualityGate,
  shouldRunIdentifierFallback,
  type IOcrNormalized,
} from './normalize.js';

export interface IRecognizeResult {
  type: HrOcrType;
  model: string | null;
  normalized: IOcrNormalized;
  qualityGate: 'ok' | 'failed';
  attempt: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export class HrOcrError extends Error {
  constructor(message: string, readonly code: 'empty_response' | 'no_data' | 'provider' | 'unsupported_image', readonly retryable: boolean, readonly retryAfterMs?: number | null) {
    super(message);
    this.name = 'HrOcrError';
  }
}

const buildMessages = (prompt: string, imageDataUrl: string): IChatMessage[] => [
  { role: 'system', content: SYSTEM_PROMPT },
  {
    role: 'user',
    content: [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: imageDataUrl } },
    ],
  },
];

const extractContent = (choice: { message?: { content?: string | null } } | undefined): string => {
  const content = choice?.message?.content;
  return typeof content === 'string' ? content : '';
};

const isUnsupportedImage = (err: unknown): boolean =>
  err instanceof OpenRouterError && err.status === 400 && /unsupported image format|invalid image|image_parse/i.test(`${err.message} ${err.body ?? ''}`);

export const recognizeDocument = async (params: { type: HrOcrType; imageDataUrl: string; documentId: number }): Promise<IRecognizeResult> => {
  const { type, imageDataUrl, documentId } = params;
  const prompt = await resolvePrompt(type);
  const attempts: Array<{ label: string; enforceJson: boolean; maxTokens: number }> = [
    { label: 'strict-json', enforceJson: true, maxTokens: 700 },
    { label: 'loose-json', enforceJson: false, maxTokens: 900 },
  ];

  let lastEmpty = false;
  let lastNoData = false;
  let lastProviderError: OpenRouterError | null = null;
  let gateFailed: IRecognizeResult | null = null;

  for (const attempt of attempts) {
    let response;
    try {
      response = await openRouterService.chatCompletion(
        {
          messages: buildMessages(prompt, imageDataUrl),
          temperature: 0.1,
          max_tokens: attempt.maxTokens,
          ...(attempt.enforceJson ? { response_format: { type: 'json_object' as const } } : {}),
        },
        { title: `hr-ocr:${type}` },
      );
    } catch (err) {
      if (isUnsupportedImage(err)) {
        throw new HrOcrError('Модель не поддерживает формат изображения', 'unsupported_image', false);
      }
      if (err instanceof OpenRouterError) {
        lastProviderError = err;
        console.warn('[hr-ocr] provider request failed', { documentId, type, attempt: attempt.label, status: err.status, retryAfterSec: err.retryAfterSec });
        // 429/5xx openRouterService уже ретраил — дальше отдаём очереди.
        if (err.status === null || err.status === 429 || err.status >= 500) break;
        continue;
      }
      throw err;
    }

    const content = extractContent(response.choices?.[0]);
    if (!content.trim()) {
      lastEmpty = true;
      console.warn('[hr-ocr] empty provider response', { documentId, type, attempt: attempt.label, model: response.resolvedModel });
      continue;
    }

    const parsed = parseStructuredJson(content) ?? {};
    let normalized = normalizeResponseByType(type, parsed);

    if (shouldRunIdentifierFallback(type, normalized)) {
      try {
        const fallbackPrompt = await resolveFallbackPrompt(type);
        const fallbackResponse = await openRouterService.chatCompletion(
          { messages: buildMessages(fallbackPrompt, imageDataUrl), temperature: 0.1, max_tokens: 1200, response_format: { type: 'json_object' } },
          { title: `hr-ocr:${type}:fallback` },
        );
        const fallbackParsed = parseStructuredJson(extractContent(fallbackResponse.choices?.[0])) ?? {};
        normalized = mergeMissingNormalizedFields(normalized, normalizeResponseByType(type, fallbackParsed));
      } catch (err) {
        console.warn('[hr-ocr] identifier fallback failed', { documentId, type, status: err instanceof OpenRouterError ? err.status : null });
      }
    }

    if (!hasMeaningfulNormalizedData(normalized)) {
      lastNoData = true;
      console.warn('[hr-ocr] no structured fields extracted', { documentId, type, attempt: attempt.label, model: response.resolvedModel });
      continue;
    }

    const result: IRecognizeResult = {
      type,
      model: response.resolvedModel ?? null,
      normalized,
      qualityGate: 'ok',
      attempt: attempt.label,
      usage: response.usage,
    };
    if (!passesQualityGate(type, normalized)) {
      console.warn('[hr-ocr] quality gate failed', { documentId, type, attempt: attempt.label });
      gateFailed = { ...result, qualityGate: 'failed' };
      continue;
    }
    console.info('[hr-ocr] recognized', { documentId, type, attempt: attempt.label, model: result.model, usage: result.usage ?? null });
    return result;
  }

  if (gateFailed) return gateFailed;
  if (lastEmpty) throw new HrOcrError('OCR провайдер вернул пустой ответ', 'empty_response', true);
  if (lastProviderError) {
    throw new HrOcrError('OCR провайдер недоступен', 'provider', true, lastProviderError.retryAfterSec ? lastProviderError.retryAfterSec * 1000 : null);
  }
  if (lastNoData) throw new HrOcrError('OCR не смог извлечь данные из документа', 'no_data', false);
  throw new HrOcrError('OCR не дал результата', 'no_data', false);
};
