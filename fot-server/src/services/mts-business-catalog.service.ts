import { MtsBusinessServiceBase } from './mts-business-base.service.js';

// Тариф/услуги/остатки пакетов/структура абонента (Product+Service-домен МТС
// Business API). BillPlanInfo и ProductInfo подтверждены по support.mts.ru.
// HierarchyStructure и точный набор `fields` у BillPlanInfo — НЕ проверены
// живым вызовом (в отличие от Bills/Documents в mts-business-data.service.ts,
// где расхождение с докой уже было найдено на реальном контуре) — парсинг
// защищённый (глубокий обход/толерантность к альтернативной форме ответа),
// но перед боевым использованием стоит свериться с логами сырого payload.

export interface IMtsTariff {
  tariffId: string | null;
  tariffName: string | null;
}

export interface IMtsService {
  code: string | null;
  name: string | null;
  status: string | null;
  monthlyAmount: number | null;
  currencyCode: string | null;
  startDateTime: string | null;
  endDateTime: string | null;
}

export interface IMtsHierarchyNumber {
  msisdn: string | null;
  accountNo: string | null;
  region: string | null;
}

export interface IMtsHierarchy {
  organizationName: string | null;
  contractId: string | null;
  accounts: string[];
  numbers: IMtsHierarchyNumber[];
}

export type MtsProductRequestStatus = 'completed' | 'in_progress' | 'faulted' | 'unknown';

const asString = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const toNumber = (v: unknown): number | null => {
  if (v == null) return null;
  const n = typeof v === 'string' ? Number.parseFloat(v) : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Глубокий обход в поисках всех объектов, содержащих один из ключей-маркеров. */
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

const parseTariff = (resp: unknown): IMtsTariff => {
  const first = Array.isArray(resp) ? resp[0] : resp;
  const r = (first ?? {}) as Record<string, unknown>;
  return {
    tariffId: asString(r.externalID) ?? asString(r.id),
    tariffName: asString(r.name),
  };
};

const parseServices = (resp: unknown): IMtsService[] => {
  const items = Array.isArray(resp) ? resp : collectByMarker(resp, 'price');
  return items
    .map(raw => {
      const r = raw as Record<string, unknown>;
      const price = r.price as Record<string, unknown> | undefined;
      const amount = toNumber(price?.taxIncludedAmount ?? price?.dutyFreeAmount);
      const name = asString(r.name);
      if (!name && amount == null) return null;
      return {
        code: asString(r.externalID),
        name,
        status: asString(r.status),
        monthlyAmount: amount,
        currencyCode: asString(price?.currencyCode),
        startDateTime: asString(r.startDateTime),
        endDateTime: asString(r.endDateTime),
      };
    })
    .filter((s): s is IMtsService => s !== null);
};

const parseHierarchy = (resp: unknown): IMtsHierarchy => {
  const accountNodes = collectByMarker(resp, 'accountNo');
  const numberNodes = collectByMarker(resp, 'productSerialNumber');
  const contractNode = collectByMarker(resp, 'description').find(n => n.description === 'NationalContract' || n.type === 'Customer');
  return {
    organizationName: asString(contractNode?.name),
    contractId: asString(contractNode?.id),
    accounts: [...new Set(accountNodes.map(n => asString(n.accountNo)).filter((v): v is string => v !== null))],
    numbers: numberNodes.map(n => ({
      msisdn: asString(n.productSerialNumber),
      accountNo: asString(n.accountNo),
      region: asString((n.product as Record<string, unknown> | undefined)?.description),
    })),
  };
};

class MtsBusinessCatalogService extends MtsBusinessServiceBase {
  async getBillPlanInfo(accountId: string, msisdn: string): Promise<IMtsTariff> {
    const resp = await this.request<unknown>('get', '/Product/BillPlanInfo', {
      accountId,
      params: {
        'productCharacteristic.name': 'MSISDN',
        'productCharacteristic.value': msisdn,
        'productLine.name': 'MobileConnectivity',
      },
    });
    return parseTariff(resp);
  }

  async getProductInfo(accountId: string, msisdn: string): Promise<IMtsService[]> {
    const resp = await this.request<unknown>('get', '/Product/ProductInfo', {
      accountId,
      params: {
        'category.name': 'MobileConnectivity',
        'marketSegment.characteristic.name': 'MSISDN',
        'marketSegment.characteristic.value': msisdn,
        'productOffering.actionAllowed': 'none',
        'productSpecificationType.name': 'service',
        fields: 'CalculatePrices',
      },
    });
    return parseServices(resp);
  }

  async getHierarchyStructure(accountId: string): Promise<IMtsHierarchy> {
    const resp = await this.request<unknown>('get', '/Service/HierarchyStructure', { accountId });
    return parseHierarchy(resp);
  }

  /**
   * Добавить/удалить услугу ИЛИ добровольную блокировку — один и тот же
   * эндпоинт (различаются только externalID: PEXXXX — услуга, BLXXXX —
   * блокировка). Контракт (тело запроса, eventID-ответ) — НЕ проверен живым
   * вызовом, только по докам support.mts.ru.
   */
  async modifyProduct(accountId: string, msisdn: string, action: 'create' | 'delete', externalID: string): Promise<{ eventId: string }> {
    const resp = await this.request<unknown>('post', '/Product/ModifyProduct', {
      accountId,
      data: {
        msisdn,
        characteristic: [{ name: 'MobileConnectivity' }],
        item: [{
          action,
          product: {
            externalID,
            productCharacteristic: [{ name: 'ResourceServiceRequestItemType', value: 'ResourceServiceRequestItem' }],
          },
        }],
      },
    });
    const r = (resp ?? {}) as Record<string, unknown>;
    const eventId = asString(r.eventID) ?? asString(r.eventId);
    if (!eventId) throw new Error('МТС Бизнес: ответ ModifyProduct без eventID');
    return { eventId };
  }

  /** Статус заявки ModifyProduct — Product/CheckRequestStatus (НЕ CheckRequestStatusByUUID, используемый для детализации). */
  async checkModifyProductStatus(accountId: string, msisdn: string, eventId: string): Promise<{ status: MtsProductRequestStatus; raw: string | null }> {
    const now = new Date();
    const start = new Date(now.getTime() - 12 * 60 * 60 * 1000); // окно не более суток — см. доку
    const fmtDay = (d: Date): string => {
      const p = (n: number): string => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    };
    const resp = await this.request<unknown>('post', '/Product/CheckRequestStatus', {
      accountId,
      data: {
        relatedParty: [{ characteristic: [{ name: 'MSISDN', value: msisdn }] }, { id: eventId }],
        validFor: { startDateTime: fmtDay(start), endDateTime: fmtDay(now) },
      },
    });
    const r = (resp ?? {}) as Record<string, unknown>;
    const raw = asString(r.status);
    const s = (raw || '').toLowerCase();
    const status: MtsProductRequestStatus = s.includes('complet') ? 'completed' : s.includes('progress') ? 'in_progress' : s.includes('fault') ? 'faulted' : 'unknown';
    return { status, raw };
  }
}

export const mtsBusinessCatalogService = new MtsBusinessCatalogService();
