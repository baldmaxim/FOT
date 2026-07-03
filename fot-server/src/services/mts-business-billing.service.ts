import { MtsBusinessServiceBase } from './mts-business-base.service.js';

// Баланс/начисления/неоплаченные счета (Bills-домен МТС Business API).
// Контракты подтверждены по support.mts.ru («Баланс и начисления»), но, как и
// у Documents/Bills в mts-business-data.service.ts, реальный ответ местами
// расходится с докой — парсинг ищет значения глубоким обходом по нескольким
// вероятным ключам, а не по одной жёсткой схеме.

export interface IMtsBalance {
  amount: number | null;
  creditLimit: number | null;
  currencyCode: string | null;
  validUntil: string | null;
}

export interface IMtsUnpaidAmount {
  accounts: string[];
  amount: number;
  currencyCode: string | null;
}

export interface IMtsCharge {
  msisdn: string;
  amount: number | null;
  periodStart: string | null;
  periodEnd: string | null;
}

const toNumber = (v: unknown): number | null => {
  if (v == null) return null;
  const n = typeof v === 'string' ? Number.parseFloat(v) : Number(v);
  return Number.isFinite(n) ? n : null;
};

const asString = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** Глубокий обход объекта/массива в поисках первого значения по одному из ключей. */
const deepFind = (body: unknown, keys: string[], depth = 0): unknown => {
  if (depth > 6 || body == null) return undefined;
  if (Array.isArray(body)) {
    for (const el of body) {
      const found = deepFind(el, keys, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof body !== 'object') return undefined;
  const b = body as Record<string, unknown>;
  for (const k of keys) {
    if (b[k] !== undefined) return b[k];
  }
  for (const v of Object.values(b)) {
    if (v && typeof v === 'object') {
      const found = deepFind(v, keys, depth + 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
};

const parseBalance = (resp: unknown): IMtsBalance => ({
  amount: toNumber(deepFind(resp, ['amount'])),
  creditLimit: toNumber(deepFind(resp, ['creditLimit'])),
  currencyCode: asString(deepFind(resp, ['unitOfMeasure', 'currencyCode', 'currencyName'])),
  validUntil: asString(deepFind(resp, ['endDateTime'])),
});

// Не дробить на по-одному запросу на номер — это уже создавало проблему с
// rate-limit у детализации звонков (см. миграцию 200).
const CHARGES_BULK_CHUNK = 1000;

class MtsBusinessBillingService extends MtsBusinessServiceBase {
  async checkBalanceByMsisdn(accountId: string, msisdn: string): Promise<IMtsBalance> {
    const resp = await this.request<unknown>('get', '/Bills/CheckBalanceByMSISDN', {
      accountId,
      params: { 'characteristic.value': msisdn, 'characteristic.name': 'MSISDN' },
    });
    return parseBalance(resp);
  }

  async checkBalanceByAccount(accountId: string, accountNo: string): Promise<IMtsBalance> {
    const resp = await this.request<unknown>('get', '/Bills/CheckBalanceByAccount', {
      accountId,
      params: { accountNo },
    });
    return parseBalance(resp);
  }

  async getUnpaidAmountByAccounts(accountId: string, accountNos: string[]): Promise<IMtsUnpaidAmount> {
    if (accountNos.length === 0) return { accounts: [], amount: 0, currencyCode: null };
    const resp = await this.request<unknown>('post', '/Bills/GetUnpaidAmountByAccountNumber', {
      accountId,
      data: { data: accountNos },
    });
    const data = deepFind(resp, ['accounts']) !== undefined
      ? resp
      : (resp as Record<string, unknown> | null)?.data ?? resp;
    const d = data as Record<string, unknown> | null;
    return {
      accounts: Array.isArray(d?.accounts) ? (d?.accounts as unknown[]).map(String) : accountNos,
      amount: toNumber(d?.amount) ?? 0,
      currencyCode: asString(d?.currencyCode ?? d?.currencyName),
    };
  }

  /** До 1000 номеров за один bulk-запрос (isBulk=true). */
  async checkChargesBulk(accountId: string, msisdns: string[]): Promise<IMtsCharge[]> {
    const out: IMtsCharge[] = [];
    for (let i = 0; i < msisdns.length; i += CHARGES_BULK_CHUNK) {
      const chunk = msisdns.slice(i, i + CHARGES_BULK_CHUNK);
      if (chunk.length === 0) continue;
      const resp = await this.request<unknown>('post', '/Bills/CheckCharges', {
        accountId,
        params: chunk.length > 1 ? { isBulk: true } : undefined,
        data: { id: chunk },
      });
      const items = Array.isArray(resp) ? resp : [resp];
      for (const raw of items) {
        const r = raw as Record<string, unknown>;
        const msisdn = asString(r?.id);
        if (!msisdn) continue;
        const remained = r.remainedAmount as Record<string, unknown> | undefined;
        const validFor = r.validFor as Record<string, unknown> | undefined;
        out.push({
          msisdn,
          amount: toNumber(remained?.amount),
          periodStart: asString(validFor?.startDateTime),
          periodEnd: asString(validFor?.endDateTime),
        });
      }
    }
    return out;
  }
}

export const mtsBusinessBillingService = new MtsBusinessBillingService();
