import { MtsBusinessServiceBase } from './mts-business-base.service.js';
import { normalizeMsisdn } from './mts-business-cdr.service.js';
import { mtsBusinessPersonalDataService } from './mts-business-personal-data.service.js';

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
  // Имя/id тарифа лежат в productOffering (объект/массив, возможно вложенно), а
  // НЕ на верхнем уровне ответа — подтверждено probe 06.07.2026 (BillPlanInfo:
  // productOffering.externalID=0495, name='Умный бизнес M (КОРП)'). Раньше парсер
  // читал верхний уровень → tariffName=null во всех снапшотах. Ищем узел с
  // externalID глубоким обходом, с фолбэком на верхний уровень.
  const first = Array.isArray(resp) ? resp[0] : resp;
  const r = (first ?? {}) as Record<string, unknown>;
  const offer = collectByMarker(resp, 'externalID')[0]
    ?? collectByMarker(resp, 'externalId')[0]
    ?? r;
  return {
    tariffId: asString(offer.externalID) ?? asString(offer.externalId) ?? asString(offer.id) ?? asString(r.id),
    tariffName: asString(offer.name) ?? asString(r.name),
  };
};

// Проверено сырым ответом 06.07.2026: цена услуги — в productOfferingPrice[] под
// name='PeriodicalPrice' (ежемесячная); у доступных тарифов — 'Price'. Отдельного
// r.price нет. Берём taxIncludedAmount (иначе dutyFreeAmount).
const priceFromPOP = (r: Record<string, unknown>): { amount: number | null; currency: string | null } => {
  const pops = Array.isArray(r.productOfferingPrice) ? (r.productOfferingPrice as Record<string, unknown>[]) : [];
  const entry = pops.find(p => asString(p.name) === 'PeriodicalPrice')
    ?? pops.find(p => asString(p.name) === 'Price')
    ?? pops.find(p => p.price && typeof p.price === 'object');
  const price = (entry?.price ?? {}) as Record<string, unknown>;
  return {
    amount: toNumber(price.taxIncludedAmount) ?? toNumber(price.dutyFreeAmount),
    currency: asString(price.currencyCode),
  };
};

const parseServices = (resp: unknown): IMtsService[] => {
  const items = Array.isArray(resp) ? (resp as Record<string, unknown>[]) : collectByMarker(resp, 'externalID');
  return items
    .map(raw => {
      const r = raw as Record<string, unknown>;
      const name = asString(r.name);
      const code = asString(r.externalID) ?? asString(r.code) ?? asString(r.id);
      if (!name && !code) return null;
      const { amount, currency } = priceFromPOP(r);
      const validFor = r.validFor as Record<string, unknown> | undefined;
      return {
        code,
        name,
        status: asString(r.status),
        monthlyAmount: amount,
        currencyCode: currency,
        startDateTime: asString(validFor?.startDateTime),
        endDateTime: asString(validFor?.endDateTime),
      };
    })
    .filter((s): s is IMtsService => s !== null);
};

/**
 * Имя текущего тарифа из списка подключённых услуг: МТС кладёт тариф отдельной
 * позицией «Ежемесячная плата <Тариф>» с ненулевой абонплатой (нулевые «…Скидка»
 * и «Ежемесячная плата за тариф» — не тариф). BillPlanInfo почти всегда отдаёт
 * пустой оффер (tariffName=null у 1486/1487), поэтому это основной источник имени
 * тарифа. Берём позицию с максимальной абонплатой; возвращаем name без префикса.
 */
export const extractTariffNameFromServices = (
  services: ReadonlyArray<{ name?: string | null; monthlyAmount?: number | null }>,
): string | null => {
  const PREFIX = /^Ежемесячная плата\s+/i;
  let best: { name: string; amount: number } | null = null;
  for (const s of services) {
    const name = typeof s?.name === 'string' ? s.name : '';
    const amount = s?.monthlyAmount ?? 0;
    if (amount <= 0 || !PREFIX.test(name) || /скидк/i.test(name)) continue;
    const stripped = name.replace(PREFIX, '').trim();
    // «…за тариф», «…за обслуживание порта VPN» и пр. — это плата за услугу, а не
    // название тарифа (реальные тарифы МТС — «Умный бизнес …», без «за»).
    if (!stripped || /^за\s/i.test(stripped)) continue;
    if (!best || amount > best.amount) best = { name: stripped, amount };
  }
  return best?.name ?? null;
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

/** Флаг наличия следующей страницы в ответе HierarchyStructure (hasMore/HasMore). */
const hasMoreFlag = (resp: unknown): boolean | null => {
  const hit = collectByMarker(resp, 'hasMore')[0] ?? collectByMarker(resp, 'HasMore')[0];
  if (!hit) return null;
  const v = hit.hasMore ?? hit.HasMore;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.trim().toLowerCase() === 'true';
  return null;
};

/** Значение из productCharacteristic: [{name,value}] (IMSI/SIM/ICCID — подтверждено дампом 06.07.2026). */
const productCharValue = (node: Record<string, unknown>, name: string): string | null => {
  const chars = Array.isArray(node.productCharacteristic)
    ? (node.productCharacteristic as Record<string, unknown>[])
    : [];
  const hit = chars.find(c => (asString(c.name) ?? '').toUpperCase() === name);
  return hit ? asString(hit.value) : null;
};

// Реальная вложенность (подтверждено дампом probe 06.07.2026):
// [{ name: <организация>, partyRole: [{ id: <контракт>, customerAccount: [{
//   accountNo, productRelationship: [{ product: { productSerialNumber,
//   description: <регион>, productCharacteristic: [{name:'IMSI'|'SIM',value}] } }] }],
//   characteristic: [{name:'INN'|'KPP',value}] }] }]
// КРИТИЧНО: accountNo лежит на customerAccount, а НЕ на узле номера — номера
// собираем ВНУТРИ каждого customerAccount, иначе принадлежность номера к ЛС
// теряется (один токен видит структуру ВСЕЙ организации, все ЛС сразу).
export const parseHierarchy = (resp: unknown): IMtsHierarchy => {
  const accountNodes = collectByMarker(resp, 'accountNo');
  const contractNode = collectByMarker(resp, 'description').find(n => n.description === 'NationalContract' || n.type === 'Customer' || n.description === 'Contract');
  const orgNode = (Array.isArray(resp) ? resp[0] : resp) as Record<string, unknown> | null;

  const numbers: IMtsHierarchyNumber[] = [];
  const seen = new Set<string>();
  const pushNumber = (prodNode: Record<string, unknown>, accountNo: string | null): void => {
    const msisdn = asString(prodNode.productSerialNumber);
    if (!msisdn || seen.has(msisdn)) return;
    seen.add(msisdn);
    numbers.push({
      msisdn,
      accountNo,
      region: asString(prodNode.description) ?? asString((prodNode.product as Record<string, unknown> | undefined)?.description),
      imsi: productCharValue(prodNode, 'IMSI') ?? asString(firstValue(prodNode, ['IMSI', 'imsi'])),
      sim: productCharValue(prodNode, 'SIM') ?? asString(firstValue(prodNode, ['SIM', 'sim', 'simId'])),
      iccid: productCharValue(prodNode, 'ICCID') ?? asString(firstValue(prodNode, ['ICCID', 'iccid'])),
    });
  };

  // Основной проход: номера внутри своего customerAccount (знаем их ЛС).
  for (const acc of accountNodes) {
    const accountNo = asString(acc.accountNo);
    for (const prodNode of collectByMarker(acc, 'productSerialNumber')) {
      pushNumber(prodNode, accountNo);
    }
  }
  // Fallback для иной схемы контура: номера вне customerAccount (без ЛС).
  for (const prodNode of collectByMarker(resp, 'productSerialNumber')) {
    pushNumber(prodNode, asString(prodNode.accountNo));
  }

  const charValue = (node: Record<string, unknown> | null | undefined, name: string): string | null => {
    const chars = node && Array.isArray(node.characteristic) ? (node.characteristic as Record<string, unknown>[]) : [];
    const hit = chars.find(c => (asString(c.name) ?? '').toUpperCase() === name);
    return hit ? asString(hit.value) : null;
  };

  return {
    organizationName: asString(orgNode?.name) ?? asString(contractNode?.name),
    contractId: asString(contractNode?.id),
    inn: charValue(contractNode, 'INN') ?? asString(firstValue(resp, ['INN', 'inn'])),
    kpp: charValue(contractNode, 'KPP') ?? asString(firstValue(resp, ['KPP', 'kpp'])),
    accounts: [...new Set(accountNodes.map(n => asString(n.accountNo)).filter((v): v is string => v !== null))],
    numbers,
  };
};

/** Узел номера в структуре абонента по нормализованному MSISDN (для карточки). */
export const findSubscriberInHierarchy = (h: IMtsHierarchy | null, rawMsisdn: string): IMtsHierarchyNumber | null => {
  if (!h) return null;
  const norm = normalizeMsisdn(rawMsisdn);
  if (!norm) return null;
  return h.numbers.find(n => normalizeMsisdn(n.msisdn) === norm) ?? null;
};

export const parseAvailableTariffs = (resp: unknown): IMtsAvailableTariff[] => {
  // Контракт подтверждён probe 10.07.2026 (ЛС СУ-10, вариант params
  // category.name=AvailibleTariffPlann → 200, массив из 12 тарифов). Форма узла:
  //   { id: '0495', name: 'Умный бизнес M (КОРП) (SS)', productOfferingPrice: [
  //     { name: 'Price', price: { dutyFreeAmount: 122.95, taxIncludedAmount: 0 } } ] }
  // id тарифа — в поле `id` (НЕ externalID, как искал прежний парсер → count=0);
  // абонплата — в price.dutyFreeAmount (taxIncludedAmount приходит 0 = скидка).
  const items = Array.isArray(resp)
    ? (resp as Record<string, unknown>[])
    : [...collectByMarker(resp, 'productOfferingPrice'), ...collectByMarker(resp, 'externalID'), ...collectByMarker(resp, 'externalId')];
  const seen = new Set<string>();
  const out: IMtsAvailableTariff[] = [];
  for (const raw of items) {
    const r = raw as Record<string, unknown>;
    const tariffId = asString(r.id) ?? asString(r.externalID) ?? asString(r.externalId);
    if (!tariffId || seen.has(tariffId)) continue;
    seen.add(tariffId);
    out.push({
      tariffId,
      name: asString(r.name) ?? asString(firstValue(r, ['name'])),
      price: deepNumber(r, ['dutyFreeAmount', 'taxIncludedAmount', 'amount', 'price', 'value']),
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

  /**
   * Включить (create) или снять (delete) правило переадресации по номеру —
   * POST /Product/ChangeCallForwarding (док §5.6). Асинхронно: ответ с eventID,
   * статус — через Product/CheckRequestStatus (как у ModifyProduct).
   * Контракт НЕ проверен живым вызовом, только по докам support.mts.ru.
   * retryOn500=false — мутация, исход первой попытки неизвестен.
   */
  async changeCallForwarding(
    accountId: string,
    msisdn: string,
    action: 'create' | 'delete',
    opts: { forwardingType: string; forwardingAddress?: string; noReplyTimer?: number; numType?: string },
  ): Promise<{ eventId: string }> {
    const productCharacteristic: Array<{ name: string; value: string }> = [
      { name: 'ForwardingType', value: opts.forwardingType },
    ];
    if (opts.forwardingAddress) {
      productCharacteristic.push({ name: 'ForwardingAddress', value: opts.forwardingAddress });
    }
    if (opts.noReplyTimer != null) {
      productCharacteristic.push({ name: 'NoReplyTimer', value: String(opts.noReplyTimer) });
    }
    productCharacteristic.push({ name: 'NumType', value: opts.numType ?? 'Regular' });

    const resp = await this.request<unknown>('post', '/Product/ChangeCallForwarding', {
      accountId,
      retryOn500: false,
      data: {
        characteristic: [{ name: 'MSISDN', value: msisdn }],
        item: [{
          action,
          product: {
            productLine: { name: 'CallForwarding' },
            productCharacteristic,
          },
        }],
      },
    });
    const r = (resp ?? {}) as Record<string, unknown>;
    const eventId = asString(r.eventID) ?? asString(r.eventId);
    if (!eventId) throw new Error('МТС Бизнес: ответ ChangeCallForwarding без eventID');
    return { eventId };
  }

  /** Текущая локация/роуминг абонента. */
  async getCurrentSubscriberLocation(accountId: string, msisdn: string): Promise<IMtsRoaming> {
    const resp = await this.request<unknown>('get', '/Service/CurrentSubscriberLocation', {
      accountId,
      params: { msisdn },
    });
    return parseRoaming(resp);
  }

  /**
   * Структура абонента с пагинацией (док §5.10: pageSize до 1000, при hasMore
   * продолжаем). На крупном ЛС без пагинации часть номеров не приходит (206
   * partial) — номера «терялись» в инвентаре. Останов: явный hasMore=false,
   * неполная страница, либо страница без НОВЫХ номеров (защита от контура,
   * который игнорирует пагинацию и повторяет ту же выдачу). Кап MAX_PAGES.
   */
  async getHierarchyStructure(accountId: string): Promise<IMtsHierarchy> {
    const PAGE_SIZE = 1000;
    const MAX_PAGES = 50;
    const merged: IMtsHierarchy = {
      organizationName: null, contractId: null, inn: null, kpp: null, accounts: [], numbers: [],
    };
    const seenAccounts = new Set<string>();
    const seenMsisdns = new Set<string>();

    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
      const resp = await this.request<unknown>('get', '/Service/HierarchyStructure', {
        accountId, params: { pageNum, pageSize: PAGE_SIZE },
      });
      const page = parseHierarchy(resp);
      merged.organizationName ??= page.organizationName;
      merged.contractId ??= page.contractId;
      merged.inn ??= page.inn;
      merged.kpp ??= page.kpp;
      for (const a of page.accounts) {
        if (!seenAccounts.has(a)) { seenAccounts.add(a); merged.accounts.push(a); }
      }
      let added = 0;
      for (const n of page.numbers) {
        const key = n.msisdn ?? '';
        if (key && seenMsisdns.has(key)) continue;
        if (key) seenMsisdns.add(key);
        merged.numbers.push(n);
        added++;
      }

      const more = hasMoreFlag(resp);
      if (more === true) continue;              // явный флаг — идём дальше
      if (more === false) break;                // явный флаг — конец
      if (page.numbers.length < PAGE_SIZE) break; // неполная страница — конец
      if (added === 0) break;                   // страница без новых номеров — контур без пагинации
    }
    return merged;
  }

  /** Сырой ответ HierarchyStructure без парсинга — только для диагностики (probe-скрипт). */
  async getHierarchyStructureRaw(accountId: string): Promise<unknown> {
    return this.request<unknown>('get', '/Service/HierarchyStructure', { accountId });
  }

  /**
   * Добавить/удалить услугу ИЛИ добровольную блокировку — один и тот же
   * эндпоинт (различаются только externalID: PEXXXX — услуга, BLXXXX —
   * блокировка). Контракт по докам §5.4: msisdn — В QUERY (?msisdn=), в теле
   * только characteristic+item. Раньше msisdn лежал в теле — гейт МТС не мог
   * привязать запрос к абоненту и отвечал 401 (Sentry FOT-SERVER-4D), т.е.
   * управление услугами не работало никогда. Тот же контракт — в changeBillPlan
   * и в probe-mts-number-all.ts --check-manage.
   * retryOn500=false — мутация, исход первой попытки неизвестен.
   */
  async modifyProduct(accountId: string, msisdn: string, action: 'create' | 'delete', externalID: string): Promise<{ eventId: string }> {
    const resp = await this.request<unknown>('post', '/Product/ModifyProduct', {
      accountId,
      params: { msisdn },
      retryOn500: false,
      data: {
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

  /**
   * Смена тарифа (POST /Product/ChangeBillPlan?msisdn=) — асинхронно, ответ с
   * eventID, статус — через Product/CheckRequestStatus (как у ModifyProduct).
   * Контракт по докам §5.7 — НЕ проверен живым вызовом; dry-run прав есть в
   * probe-mts-number-all.ts --check-manage (ChangeBillPlanValidation).
   */
  async changeBillPlan(accountId: string, msisdn: string, externalID: string): Promise<{ eventId: string }> {
    const resp = await this.request<unknown>('post', '/Product/ChangeBillPlan', {
      accountId,
      params: { msisdn },
      data: {
        item: [{
          product: {
            externalID,
            productCharacteristic: [{ name: 'productType', value: 'tariffPlan' }],
          },
        }],
      },
    });
    const r = (resp ?? {}) as Record<string, unknown>;
    const eventId = asString(r.eventID) ?? asString(r.eventId);
    if (!eventId) throw new Error('МТС Бизнес: ответ ChangeBillPlan без eventID');
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
   *
   * Формат ответа (по офиц. документации МТС Бизнес API) — МАССИВ записей, ФИО
   * лежит одной строкой в поле `name` = «Фамилия Имя Отчество»:
   *   [{ "name": "Иванов Иван Иванович",
   *      "characteristic": [{ "name": "PersonalDataConfirmation", "value": "Activated" }] }]
   * Fallback (SurName/FirstName/SecondName) оставлен на случай иной схемы контура.
   * ФИО приходит ТОЛЬКО когда персданные пользователя внесены/подтверждены на
   * стороне МТС; для SIM без внесённых данных ответ пуст — ФИО берётся из XML (<tp u>).
   */
  async getPersonalDataFio(accountId: string, msisdn: string): Promise<string | null> {
    // Делегируем в personal-data сервис (единственный парсер PersonalDataInfo) —
    // заодно кэшируется статус подтверждения в number_map.pd_status.
    const info = await mtsBusinessPersonalDataService.fetchAndCacheInfo(accountId, msisdn);
    return info.fullName;
  }

  /**
   * Комментарии номеров из ЛК МТС (`Service/GetCommentsByMSISDN`, POST, до 300
   * MSISDN за запрос). Fallback-источник имени, когда PersonalData пуст: админ в
   * ЛК часто подписывает номер («Иванов Иван / отдел»). Возвращает карту
   * нормализованный MSISDN → комментарий (пустые/битые пропускаем).
   */
  async getCommentsByMsisdn(accountId: string, msisdns: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const norm = [...new Set(msisdns.map(m => normalizeMsisdn(m)).filter((v): v is string => !!v))];
    if (!norm.length) return out;
    // Ограничение документации — до 300 номеров в запросе.
    for (let i = 0; i < norm.length; i += 300) {
      const chunk = norm.slice(i, i + 300);
      const resp = await this.request<unknown>('post', '/Service/GetCommentsByMSISDN', {
        accountId, data: { msisdns: chunk },
      });
      const items = Array.isArray(resp) ? resp : collectByMarker(resp, 'comment');
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const r = item as Record<string, unknown>;
        const m = normalizeMsisdn(asString(r.msisdn) ?? asString(r.MSISDN) ?? '');
        const comment = (asString(r.comment) ?? asString(r.Comment) ?? '').trim();
        if (m && comment) out.set(m, comment);
      }
    }
    return out;
  }
}

export const mtsBusinessCatalogService = new MtsBusinessCatalogService();
