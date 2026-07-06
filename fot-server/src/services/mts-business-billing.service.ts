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

export interface IMtsPackageCounter {
  unitOfMeasure: string | null; // BYTE | MINUTE | SECOND | ITEM | MONEY
  quota: number | null;
  remainder: number | null;
  consumption: number | null;
  rotate: string | null;
  validFrom: string | null;
  validTo: string | null;
}

export interface IMtsTariffFee {
  amount: number | null;
  currencyCode: string | null;
}

export interface IMtsPaymentEntry {
  date: string | null;
  amount: number | null;
  method: string | null;
  currencyCode: string | null;
}

export interface IMtsDeliveryMethod {
  method: string | null;         // email / paper / ...
  address: string | null;        // email или почтовый адрес
  documentFormat: string | null; // Pdf / Html / ...
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

/** Глубокий обход в поисках ВСЕХ объектов, содержащих ключ-маркер (не первого, как deepFind). */
const collectByMarker = (body: unknown, marker: string, depth = 0, out: Record<string, unknown>[] = []): Record<string, unknown>[] => {
  if (depth > 8 || body == null) return out;
  if (Array.isArray(body)) {
    for (const el of body) collectByMarker(el, marker, depth + 1, out);
    return out;
  }
  if (typeof body !== 'object') return out;
  const b = body as Record<string, unknown>;
  if (b[marker] !== undefined) out.push(b);
  for (const v of Object.values(b)) {
    if (v && typeof v === 'object') collectByMarker(v, marker, depth + 1, out);
  }
  return out;
};

const parsePackages = (resp: unknown): IMtsPackageCounter[] => {
  const items = collectByMarker(resp, 'unitOfMeasure');
  return items.map(r => {
    const validFor = r.validFor as Record<string, unknown> | undefined;
    return {
      unitOfMeasure: asString(r.unitOfMeasure),
      quota: toNumber(r.BQ),
      remainder: toNumber(r.reminder),
      consumption: toNumber(r.Consumption),
      rotate: asString(r.Rotate),
      validFrom: asString(validFor?.startDateTime),
      validTo: asString(validFor?.endDateTime),
    };
  });
};

// Контракты TariffRental/PaymentHistory/DocumentDeliveryMethod НЕ проверены
// живым вызовом — парсеры толерантны (обход по нескольким вероятным ключам).
// Перед боевым использованием свериться с сырым payload (probe-скрипт).
const parseTariffFee = (resp: unknown): IMtsTariffFee => ({
  amount: toNumber(deepFind(resp, ['taxIncludedAmount', 'dutyFreeAmount', 'amount', 'price', 'value'])),
  currencyCode: asString(deepFind(resp, ['currencyCode', 'currencyName'])),
});

const parsePaymentHistory = (resp: unknown): IMtsPaymentEntry[] => {
  const items = Array.isArray(resp) ? (resp as Record<string, unknown>[]) : collectByMarker(resp, 'amount');
  return items
    .map(raw => {
      const r = raw as Record<string, unknown>;
      const amount = toNumber(r.amount ?? deepFind(r, ['taxIncludedAmount', 'sum', 'value']));
      const date = asString(r.date ?? r.paymentDate ?? r.dateTime) ?? asString(deepFind(r, ['date', 'paymentDate', 'dateTime']));
      if (amount == null && !date) return null;
      return {
        date,
        amount,
        method: asString(r.paymentMethod ?? r.method ?? r.type ?? r.name),
        currencyCode: asString(r.currencyCode ?? r.currencyName),
      };
    })
    .filter((e): e is IMtsPaymentEntry => e !== null);
};

const parseDeliveryMethods = (resp: unknown): IMtsDeliveryMethod[] => {
  const marked = Array.isArray(resp) ? (resp as Record<string, unknown>[]) : collectByMarker(resp, 'deliveryMethod');
  const list = marked.length ? marked : (resp && typeof resp === 'object' ? [resp as Record<string, unknown>] : []);
  return list
    .map(raw => {
      const r = raw as Record<string, unknown>;
      const method = asString(r.deliveryMethod ?? r.method ?? r.type ?? r.name);
      const address = asString(r.deliveryAddress ?? r.address ?? r.email) ?? asString(deepFind(r, ['emailAddress', 'address']));
      const documentFormat = asString(r.documentFormat ?? r.format);
      if (!method && !address && !documentFormat) return null;
      return { method, address, documentFormat };
    })
    .filter((d): d is IMtsDeliveryMethod => d !== null);
};

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

  /** Остатки пакетов минут/SMS/интернета — по лицевому счёту (не по номеру, см. доку ValidityInfo). */
  async getValidityInfo(accountId: string, accountNo: string): Promise<IMtsPackageCounter[]> {
    const resp = await this.request<unknown>('get', '/Bills/ValidityInfo', {
      accountId,
      params: {
        'customerAccount.accountNo': accountNo,
        'customerAccount.productRelationship.product.productLine.name': 'Counters',
        fields: 'MOAF',
      },
    });
    return parsePackages(resp);
  }

  /** Плата по тарифу (абонплата) по номеру — дополняет BillPlanInfo (там только id/name). */
  async getTariffRental(accountId: string, msisdn: string): Promise<IMtsTariffFee> {
    const resp = await this.request<unknown>('get', '/Bills/TariffRental', {
      accountId,
      params: { msisdn },
    });
    return parseTariffFee(resp);
  }

  /** История платежей (пополнений) по номеру за период. dateFrom/dateTo — YYYY-MM-DD. */
  async getPaymentHistoryByMsisdn(accountId: string, msisdn: string, dateFrom: string, dateTo: string): Promise<IMtsPaymentEntry[]> {
    const resp = await this.request<unknown>('get', '/Bills/PaymentHistoryByMSISDN', {
      accountId,
      params: { msisdn, dateFrom, dateTo },
    });
    return parsePaymentHistory(resp);
  }

  /** Способ доставки счёта по номеру (email/бумага/формат). */
  async getDocumentDeliveryMethod(accountId: string, msisdn: string): Promise<IMtsDeliveryMethod[]> {
    const resp = await this.request<unknown>('get', '/Bills/DocumentDeliveryMethodByMSISDN', {
      accountId,
      params: {
        'customer.relatedParty.characteristic.name': 'MSISDN',
        'customer.relatedParty.characteristic.value': msisdn,
        'productRelationship.productLine.name': 'BillDeliveries',
      },
    });
    return parseDeliveryMethods(resp);
  }
}

export const mtsBusinessBillingService = new MtsBusinessBillingService();
