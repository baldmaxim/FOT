import { MtsBusinessServiceBase } from './mts-business-base.service.js';
import { normalizeMsisdn } from './mts-business-cdr.service.js';

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
  imsi: string | null;
  sim: string | null;   // ICCID/номер SIM (что вернёт API)
  iccid: string | null;
}

export interface IMtsHierarchy {
  organizationName: string | null;
  contractId: string | null;
  inn: string | null;
  kpp: string | null;
  accounts: string[];
  numbers: IMtsHierarchyNumber[];
}

export interface IMtsAvailableTariff {
  tariffId: string | null;
  name: string | null;
  price: number | null;
}

// Переадресация: ForwardingType — CFU/CFB/CFNRY/CFNRC; NumType — Regular/VoiceMail.
export interface IMtsForwardingRule {
  forwardingType: string | null;
  forwardingAddress: string | null;
  noReplyTimer: number | null;
  numType: string | null;
  status: string | null;
}

export interface IMtsRoaming {
  countryId: string | null;
  countryName: string | null;
  isInternational: boolean;
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
  const items = Array.isArray(resp) ? resp : collectByMarker(resp, 'externalID');
  return items
    .map(raw => {
      const r = raw as Record<string, unknown>;
      const price = r.price as Record<string, unknown> | undefined;
      const amount = toNumber(price?.taxIncludedAmount ?? price?.dutyFreeAmount)
        ?? deepNumber(r, ['taxIncludedAmount', 'dutyFreeAmount', 'monthlyFee', 'periodicAmount', 'amount', 'value']);
      const name = asString(r.name);
      const code = asString(r.externalID) ?? asString(r.code);
      if (!name && !code && amount == null) return null;
      return {
        code,
        name,
        status: asString(r.status),
        monthlyAmount: amount,
        currencyCode: asString(price?.currencyCode) ?? asString(firstValue(r, ['currencyCode', 'currencyName'])),
        startDateTime: asString(r.startDateTime),
        endDateTime: asString(r.endDateTime),
      };
    })
    .filter((s): s is IMtsService => s !== null);
};

/** Первое значение по одному из ключей-маркеров (глубокий обход). */
const firstValue = (node: unknown, keys: string[]): unknown => {
  for (const k of keys) {
    const hit = collectByMarker(node, k)[0];
    if (hit && hit[k] !== undefined) return hit[k];
  }
  return undefined;
};

/** Первое числовое значение по одному из ключей (для цены во вложенных структурах). */
const deepNumber = (node: unknown, keys: string[]): number | null => {
  const n = toNumber(firstValue(node, keys));
  return n;
};

const parseHierarchy = (resp: unknown): IMtsHierarchy => {
  const accountNodes = collectByMarker(resp, 'accountNo');
  const numberNodes = collectByMarker(resp, 'productSerialNumber');
  const contractNode = collectByMarker(resp, 'description').find(n => n.description === 'NationalContract' || n.type === 'Customer');
  return {
    organizationName: asString(contractNode?.name),
    contractId: asString(contractNode?.id),
    // ИНН/КПП/IMSI/SIM — НЕ проверены живым вызовом: ключи угаданы по докам,
    // при отсутствии остаются null (карточка это переживает).
    inn: asString(firstValue(resp, ['INN', 'inn'])),
    kpp: asString(firstValue(resp, ['KPP', 'kpp'])),
    accounts: [...new Set(accountNodes.map(n => asString(n.accountNo)).filter((v): v is string => v !== null))],
    numbers: numberNodes.map(n => ({
      msisdn: asString(n.productSerialNumber),
      accountNo: asString(n.accountNo),
      region: asString((n.product as Record<string, unknown> | undefined)?.description),
      imsi: asString(firstValue(n, ['IMSI', 'imsi'])),
      sim: asString(firstValue(n, ['SIM', 'sim', 'ICCID', 'iccid', 'simId'])),
      iccid: asString(firstValue(n, ['ICCID', 'iccid'])),
    })),
  };
};

/** Узел номера в структуре абонента по нормализованному MSISDN (для карточки). */
export const findSubscriberInHierarchy = (h: IMtsHierarchy | null, rawMsisdn: string): IMtsHierarchyNumber | null => {
  if (!h) return null;
  const norm = normalizeMsisdn(rawMsisdn);
  if (!norm) return null;
  return h.numbers.find(n => normalizeMsisdn(n.msisdn) === norm) ?? null;
};

const parseAvailableTariffs = (resp: unknown): IMtsAvailableTariff[] => {
  const items = Array.isArray(resp)
    ? (resp as Record<string, unknown>[])
    : [...collectByMarker(resp, 'externalID'), ...collectByMarker(resp, 'externalId')];
  const seen = new Set<string>();
  const out: IMtsAvailableTariff[] = [];
  for (const raw of items) {
    const r = raw as Record<string, unknown>;
    const tariffId = asString(r.externalID) ?? asString(r.externalId);
    if (!tariffId || seen.has(tariffId)) continue;
    seen.add(tariffId);
    out.push({
      tariffId,
      name: asString(r.name) ?? asString(firstValue(r, ['name'])),
      price: deepNumber(r, ['taxIncludedAmount', 'dutyFreeAmount', 'amount', 'price', 'value']),
    });
  }
  return out;
};

const parseForwarding = (resp: unknown): IMtsForwardingRule[] => {
  const items = Array.isArray(resp)
    ? (resp as Record<string, unknown>[])
    : [...collectByMarker(resp, 'forwardingType'), ...collectByMarker(resp, 'ForwardingType'), ...collectByMarker(resp, 'forwardingAddress')];
  const seen = new Set<string>();
  const out: IMtsForwardingRule[] = [];
  for (const raw of items) {
    const r = raw as Record<string, unknown>;
    const forwardingType = asString(r.forwardingType ?? r.ForwardingType ?? r.type);
    const forwardingAddress = asString(r.forwardingAddress ?? r.ForwardingAddress ?? r.address);
    if (!forwardingType && !forwardingAddress) continue;
    const key = `${forwardingType ?? ''}|${forwardingAddress ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      forwardingType,
      forwardingAddress,
      noReplyTimer: toNumber(r.noReplyTimer ?? r.NoReplyTimer),
      numType: asString(r.numType ?? r.NumType),
      status: asString(r.status),
    });
  }
  return out;
};

// Россия — не международный роуминг. Определяем по коду/названию (best-effort:
// если API вернёт неизвестный внутренний id, считаем международным только при
// явно не-российской стране; спека: countryId=null / пусто ⇒ не международный).
const RU_COUNTRY = new Set(['RU', 'RUS', '643', '250', '7']);
const parseRoaming = (resp: unknown): IMtsRoaming => {
  const countryId = asString(firstValue(resp, ['countryId', 'CountryId']));
  const countryName = asString(firstValue(resp, ['countryName', 'CountryName', 'country']));
  const isRuName = countryName != null && /росс|russ/i.test(countryName);
  const isInternational = Boolean(countryId) && !RU_COUNTRY.has(countryId as string) && !isRuName;
  return { countryId, countryName, isInternational };
};

class MtsBusinessCatalogService extends MtsBusinessServiceBase {
  async getBillPlanInfo(accountId: string, msisdn: string): Promise<IMtsTariff> {
    // Проверено живым вызовом 03.07.2026: без `fields` МТС отвечает голым
    // 500 "EJB Exception" (необработанное исключение на стороне МТС, а не
    // валидация) — доки помечали `fields` обязательным без примера значения.
    // 'MOAF' — значение, используемое в соседних GET-методах этого же API
    // (CheckBalanceByMSISDN, ValidityInfo); если МТС всё равно 500 — нужно
    // искать другое значение, доки для конкретно этого метода его не дают.
    const resp = await this.request<unknown>('get', '/Product/BillPlanInfo', {
      accountId,
      params: {
        'productCharacteristic.name': 'MSISDN',
        'productCharacteristic.value': msisdn,
        'productLine.name': 'MobileConnectivity',
        fields: 'MOAF',
      },
    });
    return parseTariff(resp);
  }

  /** Общий вызов ProductInfo по номеру: услуги/блокировки, подключённые/доступные. */
  private async queryProducts(
    accountId: string,
    msisdn: string,
    opts: { actionAllowed: 'none' | 'create'; specType: 'service' | 'block' },
  ): Promise<IMtsService[]> {
    const resp = await this.request<unknown>('get', '/Product/ProductInfo', {
      accountId,
      params: {
        'category.name': 'MobileConnectivity',
        'marketSegment.characteristic.name': 'MSISDN',
        'marketSegment.characteristic.value': msisdn,
        'productOffering.actionAllowed': opts.actionAllowed,
        'productSpecificationType.name': opts.specType,
        fields: 'CalculatePrices',
      },
    });
    return parseServices(resp);
  }

  /** Подключённые платные услуги номера. */
  async getProductInfo(accountId: string, msisdn: string): Promise<IMtsService[]> {
    return this.queryProducts(accountId, msisdn, { actionAllowed: 'none', specType: 'service' });
  }

  /** Доступные для подключения услуги (read-only каталог). */
  async getAvailableServices(accountId: string, msisdn: string): Promise<IMtsService[]> {
    return this.queryProducts(accountId, msisdn, { actionAllowed: 'create', specType: 'service' });
  }

  /** Подключённые блокировки номера. */
  async getConnectedBlocks(accountId: string, msisdn: string): Promise<IMtsService[]> {
    return this.queryProducts(accountId, msisdn, { actionAllowed: 'none', specType: 'block' });
  }

  /** Доступные для подключения блокировки. */
  async getAvailableBlocks(accountId: string, msisdn: string): Promise<IMtsService[]> {
    return this.queryProducts(accountId, msisdn, { actionAllowed: 'create', specType: 'block' });
  }

  /** Тарифы, доступные для перехода (read-only, справочно). */
  async getAvailableTariffs(accountId: string, msisdn: string): Promise<IMtsAvailableTariff[]> {
    const resp = await this.request<unknown>('get', '/Product/ProductInfo', {
      accountId,
      params: {
        'marketSegment.characteristic.name': 'MSISDN',
        'marketSegment.characteristic.value': msisdn,
        'category.name': 'AvailibleTariffPlann', // опечатка МТС — сохранить до опровержения дампом
        fields: 'productOffering.externalId,productOffering.productOfferingPrice.price',
      },
    });
    return parseAvailableTariffs(resp);
  }

  /** Правила переадресации по номеру (read-only). */
  async getCallForwarding(accountId: string, msisdn: string): Promise<IMtsForwardingRule[]> {
    const resp = await this.request<unknown>('get', '/Product/CallForwardingInfo', {
      accountId,
      params: {
        'productCharacteristic.name': 'MSISDN',
        'productCharacteristic.value': msisdn,
        'productLine.name': 'CallForwarding',
      },
    });
    return parseForwarding(resp);
  }

  /** Текущая локация/роуминг абонента. */
  async getCurrentSubscriberLocation(accountId: string, msisdn: string): Promise<IMtsRoaming> {
    const resp = await this.request<unknown>('get', '/Service/CurrentSubscriberLocation', {
      accountId,
      params: { msisdn },
    });
    return parseRoaming(resp);
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

  /**
   * ФИО пользователя номера — ЕДИНСТВЕННЫЙ способ получить имя для номеров
   * без XML-детализации (напр. найденных через HierarchyStructure). Эндпоинт
   * (`PersonalData/PersonalDataInfo`) отдаёт ПОЛНЫЙ пакет персданных (паспорт,
   * дата/место рождения, адрес регистрации) — сознательное решение: берём из
   * ответа ТОЛЬКО ФИО, остальные поля не парсим, никуда не пишем и не логируем
   * (см. suppressErrorBodyLog — тело ошибки этого эндпоинта тоже не в логах).
   */
  async getPersonalDataFio(accountId: string, msisdn: string): Promise<string | null> {
    const resp = await this.request<unknown>('get', '/PersonalData/PersonalDataInfo', {
      accountId,
      params: { 'contactMedium.phoneNumber': msisdn },
      suppressErrorBodyLog: true,
    });
    const r = (resp ?? {}) as Record<string, unknown>;
    const surName = asString(r.SurName) ?? asString(r.surName) ?? asString(r.LastName);
    const firstName = asString(r.FirstName) ?? asString(r.firstName);
    const secondName = asString(r.SecondName) ?? asString(r.secondName);
    const fio = [surName, firstName, secondName].filter((v): v is string => Boolean(v)).join(' ');
    return fio || null;
  }
}

export const mtsBusinessCatalogService = new MtsBusinessCatalogService();
