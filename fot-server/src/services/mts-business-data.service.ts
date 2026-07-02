import { MtsBusinessServiceBase } from './mts-business-base.service.js';
import { mtsBusinessAuthService } from './mts-business-auth.service.js';

// Доменные вызовы МТС «Бизнес» (Business API). Мультиаккаунт: все методы
// принимают accountId (свой API/лицевой счёт).
//  - заказ детализации по номеру/лицевому счёту (документ уходит на email,
//    в ответе — messageId);
//  - проверка статуса заявки по messageId.
// Контракт (подтверждено по support.mts.ru):
//   POST /Documents/CallHistoryByMSISDN   { dateFrom, dateTo, documentFormat, deliveryAddress, msisdns }
//   POST /Documents/CallHistoryByAccount  { dateFrom, dateTo, documentFormat, deliveryAddress, accounts }
//   POST /Product/CheckRequestStatusByUUID { id }  → { status: Completed|InProgress|Faulted }

export type MtsBusinessRequestStatus = 'completed' | 'in_progress' | 'faulted' | 'unknown';

export interface IMtsBusinessOrderInput {
  targets: string[];
  dateFrom: string; // YYYY-MM-DD
  dateTo: string;   // YYYY-MM-DD
  deliveryAddress: string;
}

// Проверено живым вызовом 02.07.2026 (валидатор МТС /papi-call-details):
//  - documentFormat строго в НИЖНЕМ регистре ('xml'), вопреки докам ('XML');
//  - даты без 'Z' (dateFrom — начало дня, dateTo — КОНЕЦ дня, иначе последний
//    день периода не попадает в детализацию); с 'Z' сервис отвечал 500.
const toMtsDate = (isoDate: string, boundary: 'from' | 'to'): string => {
  const d = (isoDate || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    throw new Error(`МТС Бизнес: дата должна быть в формате YYYY-MM-DD (получено "${isoDate}")`);
  }
  return boundary === 'from' ? `${d}T00:00:00` : `${d}T23:59:59`;
};

// Реальный ответ заказа (проверено 02.07.2026) — МАССИВ:
// [{ code: 200, message: "OK", request: { messageId, requests: [...] } }]
// поэтому обходим и массивы, и обёртку request.
const pickString = (body: unknown, keys: string[]): string | null => {
  if (Array.isArray(body)) {
    for (const el of body) {
      const found = pickString(el, keys);
      if (found) return found;
    }
    return null;
  }
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  for (const k of keys) {
    const v = b[k];
    if (typeof v === 'string' && v.length > 0) return v;
    if (typeof v === 'number') return String(v);
  }
  for (const wrap of ['data', 'result', 'response', 'request', 'relatedParty']) {
    const inner = b[wrap];
    if (inner && typeof inner === 'object') {
      const found = pickString(inner, keys);
      if (found) return found;
    }
  }
  return null;
};

/** Лог тела ответа без messageId: email маскируем, остальное усекаем. */
const logResponseWithoutMessageId = (endpoint: string, body: unknown): void => {
  let snippet = '';
  try { snippet = JSON.stringify(body); } catch { snippet = String(body); }
  snippet = snippet.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '***@***');
  console.error(`[mts-biz] ${endpoint}: 2xx без messageId, body: ${snippet.slice(0, 500)}`);
};

const normalizeStatus = (raw: string | null): MtsBusinessRequestStatus => {
  const s = (raw || '').toLowerCase();
  if (s.includes('complet') || s.includes('done') || s.includes('готов')) return 'completed';
  if (s.includes('progress') || s.includes('process') || s.includes('обраб') || s.includes('wait')) return 'in_progress';
  if (s.includes('fault') || s.includes('error') || s.includes('fail') || s.includes('ошиб')) return 'faulted';
  return 'unknown';
};

class MtsBusinessDataService extends MtsBusinessServiceBase {
  /** Проверка подключения аккаунта: пробуем получить свежий access_token. */
  async testConnection(accountId: string): Promise<{ ok: boolean }> {
    await mtsBusinessAuthService.getAccessToken(accountId, true);
    return { ok: true };
  }

  async orderCallDetailByMsisdn(accountId: string, input: IMtsBusinessOrderInput): Promise<{ messageId: string }> {
    const body = {
      dateFrom: toMtsDate(input.dateFrom, 'from'),
      dateTo: toMtsDate(input.dateTo, 'to'),
      documentFormat: 'xml',
      deliveryAddress: input.deliveryAddress,
      msisdns: input.targets,
    };
    const resp = await this.request<unknown>('post', '/Documents/CallHistoryByMSISDN', { accountId, data: body });
    const messageId = pickString(resp, ['messageId', 'messageID', 'id', 'requestId']);
    if (!messageId) {
      logResponseWithoutMessageId('CallHistoryByMSISDN', resp);
      throw new Error('МТС Бизнес: ответ заказа детализации без messageId');
    }
    return { messageId };
  }

  async orderCallDetailByAccount(accountId: string, input: IMtsBusinessOrderInput): Promise<{ messageId: string }> {
    const body = {
      dateFrom: toMtsDate(input.dateFrom, 'from'),
      dateTo: toMtsDate(input.dateTo, 'to'),
      documentFormat: 'xml',
      deliveryAddress: input.deliveryAddress,
      accounts: input.targets,
    };
    const resp = await this.request<unknown>('post', '/Documents/CallHistoryByAccount', { accountId, data: body });
    const messageId = pickString(resp, ['messageId', 'messageID', 'id', 'requestId']);
    if (!messageId) {
      logResponseWithoutMessageId('CallHistoryByAccount', resp);
      throw new Error('МТС Бизнес: ответ заказа детализации без messageId');
    }
    return { messageId };
  }

  async checkRequestStatus(accountId: string, messageId: string): Promise<{ status: MtsBusinessRequestStatus; raw: string | null }> {
    // Контракт (support.mts.ru «Как проверить статус заявки»): id заявки — внутри
    // массива relatedParty, validFor ОБЯЗАТЕЛЕН (без него 400 «Не указано время
    // поиска validFor»). Ищем широким окном: 30 дней назад — завтра.
    // Ответ: { relatedParty: [{ id, status: Completed|InProgress|Faulted, … }] }.
    const fmtDay = (d: Date): string => {
      const p = (n: number): string => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T00:00:00`;
    };
    const start = new Date();
    start.setDate(start.getDate() - 30);
    const end = new Date();
    end.setDate(end.getDate() + 1);

    const resp = await this.request<unknown>('post', '/Product/CheckRequestStatusByUUID', {
      accountId,
      data: {
        relatedParty: [{ characteristic: [] }, { id: messageId }],
        validFor: { startDateTime: fmtDay(start), endDateTime: fmtDay(end) },
      },
    });
    const raw = pickString(resp, ['status', 'state']);
    return { status: normalizeStatus(raw), raw };
  }

  /** Сброс кэшей клиентов и токенов (после смены аккаунтов/URL). */
  invalidate(): void {
    super.invalidate();
    mtsBusinessAuthService.invalidate();
  }
}

export const mtsBusinessDataService = new MtsBusinessDataService();
