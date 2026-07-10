import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- Хоистнутые моки внешних зависимостей ---
const { pgQueryOne, pgExecute, pgQuery, axiosGet, r2Download, ensureMock, sharpMock } = vi.hoisted(() => ({
  pgQueryOne: vi.fn(),
  pgExecute: vi.fn(),
  pgQuery: vi.fn(),
  axiosGet: vi.fn(),
  r2Download: vi.fn(),
  ensureMock: vi.fn(),
  sharpMock: vi.fn(),
}));

const { chatMock } = vi.hoisted(() => ({ chatMock: vi.fn() }));

vi.mock('../config/postgres.js', () => ({
  query: pgQuery,
  queryOne: pgQueryOne,
  execute: pgExecute,
  withTransaction: vi.fn(),
}));

vi.mock('axios', () => ({ default: { get: axiosGet } }));

vi.mock('./r2.service.js', () => ({
  r2Service: { generateDownloadUrl: r2Download },
}));

// Реальный isHeicBuffer (byte-detection), мок только конвертации.
vi.mock('./image-normalize.service.js', async (importActual) => {
  const actual = await importActual<typeof import('./image-normalize.service.js')>();
  return { ...actual, ensureBrowserFriendlyImage: ensureMock };
});

vi.mock('sharp', () => ({ default: sharpMock }));

// Лёгкий OpenRouterError в моке — тот же класс, что импортит сервис (instanceof совпадёт).
vi.mock('./openrouter.service.js', () => {
  class OpenRouterError extends Error {
    status: number | null;
    retryAfterSec: number | null;
    body: string | null;
    constructor(message: string, status: number | null, retryAfterSec: number | null = null, body: string | null = null) {
      super(message);
      this.name = 'OpenRouterError';
      this.status = status;
      this.retryAfterSec = retryAfterSec;
      this.body = body;
    }
  }
  return { OpenRouterError, openRouterService: { chatCompletion: chatMock } };
});

vi.mock('./patent-receipt-encryption.helper.js', () => ({
  encryptReceiptFields: (row: Record<string, unknown>) => row,
  encryptRawResponse: () => 'enc',
}));

import {
  aiReceiptRecognitionService,
  buildImagePart,
  UnsupportedReceiptFormatError,
} from './ai-receipt-recognition.service.js';
import { OpenRouterError } from './openrouter.service.js';

// HEIC-магия: ...ftyp + brand 'heic'. isHeicBuffer вернёт true.
const HEIC_BYTES = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypheic', 'ascii'), Buffer.alloc(8)]);
const NON_HEIC_BYTES = Buffer.from('just some png-ish bytes not heic');
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

interface IDocOverrides {
  id?: number;
  employee_id?: number | null;
  category?: string;
  file_name?: string;
  file_size?: number;
  mime_type?: string;
  r2_key?: string;
}

const makeDoc = (o: IDocOverrides = {}) => ({
  id: o.id ?? 7226,
  employee_id: o.employee_id ?? null,
  category: o.category ?? 'patent_check',
  file_name: o.file_name ?? 'receipt.jpg',
  file_size: o.file_size ?? 1024,
  mime_type: o.mime_type ?? 'image/jpeg',
  r2_key: o.r2_key ?? 'documents/52/abc.jpg',
});

const okCompletion = {
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content: JSON.stringify({
          source_type: 'sber_pdf',
          payment_date: '2026-01-31',
          payment_amount: 10000,
          confidence: 0.9,
        }),
      },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0 },
  resolvedModel: 'test-model',
};

const decodeDataUrl = (url: string): Buffer => {
  const b64 = url.slice(url.indexOf(',') + 1);
  return Buffer.from(b64, 'base64');
};

beforeEach(() => {
  vi.clearAllMocks();
  r2Download.mockResolvedValue('https://r2.example/presigned');
  axiosGet.mockResolvedValue({ data: HEIC_BYTES });
  ensureMock.mockResolvedValue({ buffer: JPEG_BYTES, mimeType: 'image/jpeg', fileName: 'receipt.jpg', size: JPEG_BYTES.length });
  sharpMock.mockReturnValue({ jpeg: () => ({ toBuffer: async () => JPEG_BYTES }) });
  chatMock.mockResolvedValue(okCompletion);
});

describe('buildImagePart', () => {
  it('поддержанный png <4МБ без forceNormalize → presigned URL, без скачивания', async () => {
    const part = await buildImagePart(makeDoc({ mime_type: 'image/png', file_size: 1000 }));
    expect(part.image_url.url).toBe('https://r2.example/presigned');
    expect(axiosGet).not.toHaveBeenCalled();
  });

  it('PDF → base64 data:application/pdf, без нормализации/sharp', async () => {
    axiosGet.mockResolvedValueOnce({ data: Buffer.from('%PDF-1.7') });
    const part = await buildImagePart(makeDoc({ mime_type: 'application/pdf', r2_key: 'documents/52/x.pdf' }));
    expect(part.image_url.url.startsWith('data:application/pdf;base64,')).toBe(true);
    expect(ensureMock).not.toHaveBeenCalled();
    expect(sharpMock).not.toHaveBeenCalled();
  });

  it('HEIC (image/heic) → конвертируется в реальные JPEG-байты', async () => {
    const part = await buildImagePart(makeDoc({ mime_type: 'image/heic', file_name: 'r.heic', r2_key: 'documents/52/r.heic' }));
    expect(part.image_url.url.startsWith('data:image/jpeg;base64,')).toBe(true);
    const bytes = decodeDataUrl(part.image_url.url);
    // magic-bytes JPEG: FF D8 FF
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xff, 0xd8, 0xff]);
    expect(ensureMock).toHaveBeenCalledOnce();
    expect(sharpMock).not.toHaveBeenCalled();
  });

  it('замаскированный HEIC (mime .jpg) при forceNormalize → детект по байтам → JPEG', async () => {
    const part = await buildImagePart(
      makeDoc({ mime_type: 'image/jpeg', file_name: 'fake.jpg' }),
      { forceNormalize: true },
    );
    expect(part.image_url.url.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(ensureMock).toHaveBeenCalledOnce();
  });

  it('HEIC, конвертация не удалась (фолбэк вернул HEIC) → UnsupportedReceiptFormatError, не JPEG', async () => {
    ensureMock.mockResolvedValueOnce({ buffer: HEIC_BYTES, mimeType: 'image/heic', fileName: 'r.heic', size: HEIC_BYTES.length });
    await expect(
      buildImagePart(makeDoc({ mime_type: 'image/heic', r2_key: 'documents/52/r.heic' })),
    ).rejects.toBeInstanceOf(UnsupportedReceiptFormatError);
  });

  it('прочий неподдержанный не-HEIC формат → sharp().jpeg()', async () => {
    axiosGet.mockResolvedValueOnce({ data: NON_HEIC_BYTES });
    const part = await buildImagePart(makeDoc({ mime_type: 'image/tiff', r2_key: 'documents/52/x.tiff' }));
    expect(part.image_url.url.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(sharpMock).toHaveBeenCalledOnce();
  });
});

// --- Тесты retry-механизма через recognizePatentReceipt ---

const setupDbForDoc = (doc: ReturnType<typeof makeDoc>) => {
  pgQueryOne.mockImplementation(async (sql: string) => {
    if (typeof sql === 'string') {
      if (sql.includes('recognition_attempts') && sql.includes('FROM documents')) return { recognition_attempts: 0 };
      if (sql.includes('FROM documents')) return doc;
      if (sql.includes('FROM employees')) return { full_name: 'X' };
      if (sql.includes('INSERT INTO patent_payment_receipts')) return { id: 1 };
    }
    return null;
  });
  pgExecute.mockResolvedValue(undefined);
};

const err400Unsupported = new OpenRouterError(
  'OpenRouter error 400: Unsupported image format for URL: .../r.heic. Supported formats: PNG, JPEG, WebP, GIF.',
  400,
);

describe('recognizePatentReceipt — format-retry', () => {
  it('замаскированный HEIC: первый 400 → нормализация → ровно 2 вызова, статус done', async () => {
    // Маленький jpg-по-mime, но байты HEIC → первый вызов уходит URL-путём и падает 400.
    const doc = makeDoc({ mime_type: 'image/jpeg', file_size: 1000, r2_key: 'documents/52/fake.jpg' });
    setupDbForDoc(doc);
    chatMock.mockRejectedValueOnce(err400Unsupported).mockResolvedValueOnce(okCompletion);

    const res = await aiReceiptRecognitionService.recognizePatentReceipt(doc.id);

    expect(chatMock).toHaveBeenCalledTimes(2);
    expect(res.status).toBe('done');
    // Второй вызов ушёл с JPEG data-url, не с исходным URL.
    const secondUrl = chatMock.mock.calls[1][0].messages[1].content[1].image_url.url as string;
    expect(secondUrl.startsWith('data:image/jpeg;base64,')).toBe(true);
  });

  it('повторный 400 после ретрая → третьего запроса нет, статус failed', async () => {
    const doc = makeDoc({ mime_type: 'image/heic', r2_key: 'documents/52/r.heic' });
    setupDbForDoc(doc);
    chatMock.mockRejectedValue(err400Unsupported);

    const res = await aiReceiptRecognitionService.recognizePatentReceipt(doc.id);

    expect(chatMock).toHaveBeenCalledTimes(2);
    expect(res.status).toBe('failed');
  });

  it('403 → retry не запускается (один вызов)', async () => {
    const doc = makeDoc({ mime_type: 'image/jpeg' });
    setupDbForDoc(doc);
    chatMock.mockRejectedValue(new OpenRouterError('OpenRouter error 403: forbidden', 403));

    const res = await aiReceiptRecognitionService.recognizePatentReceipt(doc.id);

    expect(chatMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe('failed');
  });

  it('429 → retry не запускается (один вызов)', async () => {
    const doc = makeDoc({ mime_type: 'image/jpeg' });
    setupDbForDoc(doc);
    chatMock.mockRejectedValue(new OpenRouterError('OpenRouter error 429: rate limit', 429));

    const res = await aiReceiptRecognitionService.recognizePatentReceipt(doc.id);

    expect(chatMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe('failed');
  });

  it('прочий 400 (не про формат) → retry не запускается (один вызов)', async () => {
    const doc = makeDoc({ mime_type: 'image/jpeg' });
    setupDbForDoc(doc);
    chatMock.mockRejectedValue(new OpenRouterError('OpenRouter error 400: invalid model', 400));

    const res = await aiReceiptRecognitionService.recognizePatentReceipt(doc.id);

    expect(chatMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe('failed');
  });

  it('PDF + точный 400 Unsupported image format → ровно один вызов (PDF исключён из retry)', async () => {
    const doc = makeDoc({ mime_type: 'application/pdf', r2_key: 'documents/52/x.pdf' });
    setupDbForDoc(doc);
    axiosGet.mockResolvedValue({ data: Buffer.from('%PDF-1.7') });
    chatMock.mockRejectedValue(err400Unsupported);

    const res = await aiReceiptRecognitionService.recognizePatentReceipt(doc.id);

    expect(chatMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe('failed');
  });
});
