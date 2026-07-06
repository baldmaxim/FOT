/**
 * Проба МТС Бизнес API: ВСЯ доступная информация по одному номеру (READ-ONLY).
 *
 * Обходит все известные read-only эндпоинты api.mts.ru/b2b/v1 для MSISDN:
 * структура/ЛС, персональные данные (ФИО), комментарии, баланс, начисления,
 * тариф и абонплата, услуги/блокировки (подключённые и доступные), доступные
 * тарифы, переадресация, роуминг, доставка счетов, история платежей, выписки
 * (обычная и расширенная), заявки за сегодня, остатки пакетов, долг по ЛС.
 *
 * Ничего не пишет ни в БД, ни в МТС. Аккаунт (логин/пароль) берётся из
 * mts_business_accounts; токен/лимиты — через MtsBusinessServiceBase.
 *
 * Запуск (локально или на проде из /opt/fot-build):
 *   npx tsx fot-server/scripts/probe-mts-number-all.ts 79151204230
 *   npx tsx fot-server/scripts/probe-mts-number-all.ts 79151204230 --days=7 --full
 * Флаги:
 *   --account=<id>  не резолвить аккаунт по номеру, а взять этот id
 *   --days=N        окно выписок, дней назад (по умолчанию 7)
 *   --full          не маскировать ПДн в консоли и печатать длинные сниппеты
 *   --no-file       не писать полный JSON-дамп в fot-server/tmp/
 *   --check-manage  ТОЛЬКО проверка прав на управление: два валидационных
 *                   вызова (ChangeBillPlanValidation и PATCH ModifyProduct с
 *                   ValidateMobileConnectivity). По документации МТС это
 *                   dry-run методы — тариф/услуги НЕ меняются.
 *
 * В консоли ПДн маскируются (ФИО/паспорт/email → первая буква+***). Полный
 * сырой дамп уходит в fot-server/tmp/mts-probe-*.json (папка в .gitignore) —
 * файл содержит ПДн, не коммитить и не пересылать.
 */
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- аргументы (до загрузки env, чтобы --help работал без .env) ----------
const rawArgs = process.argv.slice(2);
const flags = new Map<string, string>();
const positional: string[] = [];
for (const a of rawArgs) {
  if (a.startsWith('--')) {
    const eq = a.indexOf('=');
    if (eq === -1) flags.set(a.slice(2), '1');
    else flags.set(a.slice(2, eq), a.slice(eq + 1));
  } else {
    positional.push(a);
  }
}
if (flags.has('help')) {
  console.log('Использование: npx tsx fot-server/scripts/probe-mts-number-all.ts <msisdn> [--account=<id>] [--days=N] [--full] [--no-file] [--check-manage]');
  process.exit(0);
}

// .env грузим ДО импорта app-модулей (env.ts валидирует при импорте).
const envCandidates = [
  process.env.MTS_ENV_FILE,
  path.resolve(process.cwd(), '.env'),
  '/srv/sites/fot.su10.ru/fot-server/.env',
  path.resolve(__dirname, '../.env'),
].filter((p): p is string => Boolean(p));
const envPath = envCandidates.find(p => fs.existsSync(p));
if (envPath) {
  dotenv.config({ path: envPath });
  console.log(`[env] загружен ${envPath}`);
} else {
  console.warn('[env] .env не найден — переменные должны быть уже в окружении');
}

// ---------- маскировка ПДн для консоли ----------
const NAME_KEYS = new Set([
  'fio', 'name', 'u', 'user', 'userName', 'subscriberName', 'ownerName',
  'SurName', 'surName', 'FirstName', 'firstName', 'SecondName', 'secondName', 'LastName',
  'comment', 'Comment',
]);
const DOC_KEYS = new Set([
  'DocumentNumber', 'documentNumber', 'DocumentSeries', 'documentSeries',
  'Birthday', 'birthday', 'BirthPlace', 'birthPlace', 'Issuer', 'issuer', 'IssuerCode',
  'Street', 'Home', 'Apartment', 'Zip', 'City', 'Region',
]);
const maskPii = (v: unknown, key?: string): unknown => {
  if (typeof v === 'string') {
    let s = v.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '***@***');
    if (key && (NAME_KEYS.has(key) || DOC_KEYS.has(key)) && s.length > 1) s = `${s[0]}***`;
    return s;
  }
  if (Array.isArray(v)) return v.map(x => maskPii(x));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = maskPii(val, k);
    return out;
  }
  return v;
};
const maskEmails = (v: unknown): unknown => {
  if (typeof v === 'string') return v.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '***@***');
  if (Array.isArray(v)) return v.map(maskEmails);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = maskEmails(val);
    return out;
  }
  return v;
};

// ---------- утилиты ----------
const isoDay = (offsetDays = 0): string => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};
const stamp = (): string => {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
const describe = (data: unknown): string => {
  if (data == null) return 'null';
  if (Array.isArray(data)) return `массив, ${data.length} эл.`;
  if (typeof data === 'object') {
    const keys = Object.keys(data as Record<string, unknown>);
    return `объект, ключи: ${keys.slice(0, 15).join(', ')}${keys.length > 15 ? ', …' : ''}`;
  }
  if (typeof data === 'string') return `строка, ${data.length} зн.`;
  return typeof data;
};
const isEmptyData = (data: unknown): boolean => {
  if (data == null) return true;
  if (Array.isArray(data)) return data.length === 0;
  if (typeof data === 'string') return data.trim() === '';
  if (typeof data === 'object') return Object.keys(data as Record<string, unknown>).length === 0;
  return false;
};
const collectNumberNodes = (root: unknown): Record<string, unknown>[] => {
  const nodes: Record<string, unknown>[] = [];
  const walk = (o: unknown): void => {
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (o && typeof o === 'object') {
      const r = o as Record<string, unknown>;
      if ('productSerialNumber' in r) nodes.push(r);
      Object.values(r).forEach(walk);
    }
  };
  walk(root);
  return nodes;
};

type ProbeOutcome =
  | { kind: 'data'; ms: number; data: unknown }
  | { kind: 'empty'; ms: number; data: unknown }
  | { kind: 'unavailable'; ms: number }
  | { kind: 'error'; ms: number; message: string; status?: number; code?: string }
  | { kind: 'skipped'; reason: string };

interface IProbeResult {
  title: string;
  endpoint: string;
  outcome: ProbeOutcome;
}

const main = async (): Promise<void> => {
  const msisdnArg = positional[0] ?? '79151204230';
  const days = Math.max(1, Math.min(31, Number(flags.get('days')) || 7));
  const full = flags.has('full');
  const writeDump = !flags.has('no-file');
  const snippetLimit = full ? 20_000 : 1_500;

  const { MtsBusinessServiceBase, MtsBusinessApiError, isFeatureUnavailable } = await import('../src/services/mts-business-base.service.js');
  const { mtsBusinessAccountsService } = await import('../src/services/mts-business-accounts.service.js');
  const { mtsBusinessMappingService } = await import('../src/services/mts-business-mapping.service.js');
  const { normalizeMsisdn } = await import('../src/services/mts-business-cdr.service.js');

  const msisdn = normalizeMsisdn(msisdnArg);
  if (!msisdn) {
    console.error(`Некорректный номер: "${msisdnArg}" (ожидается 7XXXXXXXXXX)`);
    process.exit(1);
  }
  const msisdnMasked = `${msisdn.slice(0, 4)}***${msisdn.slice(-3)}`;

  class ProbeClient extends MtsBusinessServiceBase {
    raw(
      method: 'get' | 'post' | 'patch',
      endpoint: string,
      opts: { accountId: string; params?: Record<string, unknown>; data?: unknown; suppressErrorBodyLog?: boolean },
    ): Promise<unknown> {
      return this.request<unknown>(method, endpoint, { ...opts, timeout: 30_000 });
    }
  }
  const client = new ProbeClient();

  // ---------- резолв аккаунта ----------
  const accounts = await mtsBusinessAccountsService.list();
  let accountId = flags.get('account') ?? null;
  let ctxAccountNo: string | null = null;
  let hierarchyRaw: unknown; // кэш ответа HierarchyStructure?msisdn, если получили при поиске

  if (!accountId) {
    const ctx = await mtsBusinessMappingService.getSubscriberContext(msisdn);
    if (ctx?.accountId) {
      accountId = ctx.accountId;
      ctxAccountNo = ctx.accountNo ?? null;
    }
  }
  if (!accountId) {
    console.log('Номер не привязан к аккаунту в БД — перебираю активные аккаунты через HierarchyStructure…');
    for (const acc of accounts.filter(a => a.isActive && a.hasPassword)) {
      try {
        const raw = await client.raw('get', '/Service/HierarchyStructure', { accountId: acc.id, params: { msisdn } });
        const found = collectNumberNodes(raw).some(n => normalizeMsisdn(String(n.productSerialNumber ?? '')) === msisdn);
        if (found) { accountId = acc.id; hierarchyRaw = raw; break; }
      } catch { /* номер не на этом аккаунте — пробуем следующий */ }
    }
  }
  if (!accountId) {
    console.error('Не удалось определить аккаунт МТС для номера: не привязан в БД и не найден в структуре ни одного активного аккаунта.');
    console.error('Подсказка: передай аккаунт явно: --account=<id> (см. таблицу mts_business_accounts).');
    process.exit(1);
  }
  const account = accounts.find(a => a.id === accountId);
  console.log(`\nПроба: номер ${msisdnMasked}, аккаунт «${account?.label ?? accountId}», окно выписок ${days} дн.\n`);

  // ---------- режим --check-manage: только валидационные вызовы управления ----------
  if (flags.has('check-manage')) {
    const aidM = accountId;
    const asStr = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
    const printResp = (label: string, data: unknown): void => {
      let text = '';
      try { text = JSON.stringify(maskEmails(data)); } catch { text = String(data); }
      console.log(`   ${label}: ${text.slice(0, 4000)}${text.length > 4000 ? ' …(усечено)' : ''}`);
    };
    const explainError = (e: unknown): string => {
      if (isFeatureUnavailable(e)) return '403/1010 — метод НЕ входит в подписку: управление этим действием через API недоступно';
      if (e instanceof MtsBusinessApiError) {
        if (e.status === 401) return `401${e.code ? `/${e.code}` : ''} — токен не имеет прав на метод (не входит в пакет API)`;
        if (e.status === 400) return `400 — метод ДОСТУПЕН (авторизация прошла), но тело/параметры не приняты: ${e.message}${e.description ? ` / ${e.description}` : ''}`;
        if (e.status === 404) return `404 — метод ДОСТУПЕН, но объект не найден (проверить externalID): ${e.message}`;
        return `HTTP ${e.status}${e.code ? ` code=${e.code}` : ''} — ${e.message}${e.description ? ` / ${e.description}` : ''}`;
      }
      return e instanceof Error ? e.message : String(e);
    };

    console.log('=== ПРОВЕРКА ПРАВ НА УПРАВЛЕНИЕ (dry-run, ничего не меняет) ===\n');

    // Валидация асинхронная: 2xx+eventID = заявка-проверка принята. Результат
    // самой проверки читаем через CheckRequestStatus по eventID (read-only).
    const pollStatus = async (eventId: string): Promise<void> => {
      const fmt = (d: Date): string => {
        const p = (n: number): string => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
      };
      await new Promise(r => setTimeout(r, 4000));
      const now = new Date();
      try {
        const resp = await client.raw('post', '/Product/CheckRequestStatus', {
          accountId: aidM,
          data: {
            relatedParty: [{ characteristic: [{ name: 'MSISDN', value: msisdn }] }, { id: eventId }],
            validFor: {
              startDateTime: fmt(new Date(now.getTime() - 60 * 60 * 1000)),
              endDateTime: fmt(new Date(now.getTime() + 60_000)),
            },
          },
        });
        printResp('статус заявки-проверки (через 4с)', resp);
      } catch (e) {
        console.log(`   статус заявки-проверки: ${explainError(e)}`);
      }
    };

    // Кандидаты: доступный тариф и БЕСПЛАТНАЯ доступная услуга (для валидации цена
    // не важна — dry-run; бесплатную берём как кандидата и для будущей боевой пробы).
    let tariffId: string | null = null;
    let tariffName: string | null = null;
    try {
      const tariffs = await client.raw('get', '/Product/ProductInfo', {
        accountId: aidM,
        params: {
          'marketSegment.characteristic.name': 'MSISDN',
          'marketSegment.characteristic.value': msisdn,
          'category.name': 'AvailibleTariffPlann',
          fields: 'productOffering.externalId,productOffering.productOfferingPrice.price',
        },
      });
      const items = (Array.isArray(tariffs) ? tariffs : []) as Record<string, unknown>[];
      const t = items.find(x => asStr(x.externalID) ?? asStr(x.externalId) ?? asStr(x.id));
      tariffId = t ? (asStr(t.externalID) ?? asStr(t.externalId) ?? asStr(t.id)) : null;
      tariffName = t ? asStr(t.name) : null;
      console.log(`Кандидат-тариф: ${tariffName ?? '-'} (externalID=${tariffId ?? '-'}) из ${items.length} доступных`);
    } catch (e) {
      console.log(`Список доступных тарифов не получен: ${explainError(e)}`);
    }

    let serviceId: string | null = null;
    let serviceName: string | null = null;
    let serviceFree = false;
    try {
      const services = await client.raw('get', '/Product/ProductInfo', {
        accountId: aidM,
        params: {
          'category.name': 'MobileConnectivity',
          'marketSegment.characteristic.name': 'MSISDN',
          'marketSegment.characteristic.value': msisdn,
          'productOffering.actionAllowed': 'create',
          'productSpecificationType.name': 'service',
          fields: 'CalculatePrices',
        },
      });
      const items = (Array.isArray(services) ? services : []) as Record<string, unknown>[];
      const isFree = (s: Record<string, unknown>): boolean => {
        const prices = Array.isArray(s.productOfferingPrice) ? (s.productOfferingPrice as Record<string, unknown>[]) : [];
        const amounts = prices
          .filter(p => p.type === 'ProductOfferingPrice')
          .map(p => p.price as Record<string, unknown> | undefined)
          .filter((p): p is Record<string, unknown> => Boolean(p))
          .flatMap(p => [p.dutyFreeAmount, p.taxIncludedAmount])
          .map(v => Number(v) || 0);
        return amounts.length > 0 && amounts.every(a => a === 0);
      };
      const withId = items.filter(x => asStr(x.externalID));
      const freeOne = withId.find(isFree);
      const chosen = freeOne ?? withId[0];
      serviceId = chosen ? asStr(chosen.externalID) : null;
      serviceName = chosen ? asStr(chosen.name) : null;
      serviceFree = Boolean(freeOne);
      console.log(`Кандидат-услуга: ${serviceName ?? '-'} (externalID=${serviceId ?? '-'}, ${serviceFree ? 'бесплатная' : 'ПЛАТНАЯ — только для dry-run'}) из ${items.length} доступных`);
    } catch (e) {
      console.log(`Список доступных услуг не получен: ${explainError(e)}`);
    }

    // [1] Валидация смены тарифа — POST /Product/ChangeBillPlanValidation (dry-run по доке).
    console.log('\n── [1/2] Валидация смены тарифа — POST /Product/ChangeBillPlanValidation');
    if (!tariffId) {
      console.log('   · пропуск: нет externalID тарифа');
    } else {
      try {
        const resp = await client.raw('post', '/Product/ChangeBillPlanValidation', {
          accountId: aidM,
          params: { msisdn },
          data: {
            item: [{
              product: {
                externalID: tariffId,
                productCharacteristic: [{ name: 'productType', value: 'tariffPlan' }],
              },
            }],
          },
        });
        console.log('   ✓ УПРАВЛЕНИЕ ТАРИФОМ ДОСТУПНО: валидация принята (2xx)');
        printResp('ответ', resp);
        const ev = asStr((resp as Record<string, unknown> | null)?.eventID);
        if (ev) await pollStatus(ev);
      } catch (e) {
        console.log(`   ✗ ${explainError(e)}`);
      }
    }

    // [2] Валидация подключения услуги — PATCH /Product/ModifyProduct + ValidateMobileConnectivity (dry-run по доке).
    console.log('\n── [2/2] Валидация подключения услуги — PATCH /Product/ModifyProduct (ValidateMobileConnectivity)');
    if (!serviceId) {
      console.log('   · пропуск: нет externalID услуги');
    } else {
      try {
        const resp = await client.raw('patch', '/Product/ModifyProduct', {
          accountId: aidM,
          params: { msisdn },
          data: {
            characteristic: [{ name: 'ValidateMobileConnectivity' }],
            item: [{
              action: 'create',
              product: {
                externalID: serviceId,
                productCharacteristic: [{ name: 'ResourceServiceRequestItemType', value: 'ResourceServiceRequestItem' }],
              },
            }],
          },
        });
        console.log('   ✓ УПРАВЛЕНИЕ УСЛУГАМИ ДОСТУПНО: валидация принята (2xx)');
        printResp('ответ', resp);
        const ev = asStr((resp as Record<string, unknown> | null)?.eventID);
        if (ev) await pollStatus(ev);
      } catch (e) {
        console.log(`   ✗ ${explainError(e)}`);
      }
    }

    console.log('\nИтог: 2xx = права на управление есть; 400/404 = метод доступен, но контракт тела уточнить; 401/1014 или 403/1010 = управляющие методы не входят в пакет API.');
    process.exit(0);
  }

  // ---------- список проб ----------
  interface IProbeDef {
    title: string;
    endpoint: string;
    pii?: boolean; // маскировать значения именных/паспортных ключей в консоли
    run: () => Promise<unknown>;
  }

  const stmtFrom = isoDay(-days);
  const today = isoDay(0);
  const payFrom = isoDay(-30);
  const aid = accountId;

  const probes: IProbeDef[] = [
    {
      title: 'Структура номера (ЛС, IMSI, SIM/ICCID, регион, орг-данные)',
      endpoint: 'GET /Service/HierarchyStructure?msisdn=',
      pii: true,
      run: async () => hierarchyRaw ?? client.raw('get', '/Service/HierarchyStructure', { accountId: aid, params: { msisdn } }),
    },
    {
      title: 'Персональные данные пользователя номера (ФИО, статус подтверждения)',
      endpoint: 'GET /PersonalData/PersonalDataInfo',
      pii: true,
      run: () => client.raw('get', '/PersonalData/PersonalDataInfo', {
        accountId: aid,
        params: { 'contactMedium.phoneNumber': msisdn },
        suppressErrorBodyLog: true,
      }),
    },
    {
      title: 'Комментарий номера из ЛК МТС',
      endpoint: 'POST /Service/GetCommentsByMSISDN',
      pii: true,
      run: () => client.raw('post', '/Service/GetCommentsByMSISDN', { accountId: aid, data: { msisdns: [msisdn] } }),
    },
    {
      title: 'Баланс номера',
      endpoint: 'GET /Bills/CheckBalanceByMSISDN',
      run: () => client.raw('get', '/Bills/CheckBalanceByMSISDN', {
        accountId: aid,
        params: { 'characteristic.value': msisdn, 'characteristic.name': 'MSISDN' },
      }),
    },
    {
      title: 'Текущие начисления номера',
      endpoint: 'POST /Bills/CheckCharges',
      // Тело как в доке МТС: массив объектов [{id}]. Наш сервис шлёт {id:[...]} —
      // если этот вариант отвечает 200, в сервисе формат неверный.
      run: () => client.raw('post', '/Bills/CheckCharges', { accountId: aid, data: [{ id: msisdn }] }),
    },
    {
      title: 'Абонентская плата по тарифу',
      endpoint: 'GET /Bills/TariffRental',
      run: () => client.raw('get', '/Bills/TariffRental', { accountId: aid, params: { msisdn } }),
    },
    {
      title: 'Текущий тариф номера',
      endpoint: 'GET /Product/BillPlanInfo',
      run: () => client.raw('get', '/Product/BillPlanInfo', {
        accountId: aid,
        params: {
          'productCharacteristic.name': 'MSISDN',
          'productCharacteristic.value': msisdn,
          'productLine.name': 'MobileConnectivity',
          fields: 'MOAF',
        },
      }),
    },
    {
      title: 'Подключённые услуги (со стоимостью)',
      endpoint: 'GET /Product/ProductInfo (service, none)',
      run: () => client.raw('get', '/Product/ProductInfo', {
        accountId: aid,
        params: {
          'category.name': 'MobileConnectivity',
          'marketSegment.characteristic.name': 'MSISDN',
          'marketSegment.characteristic.value': msisdn,
          'productOffering.actionAllowed': 'none',
          'productSpecificationType.name': 'service',
          fields: 'CalculatePrices',
        },
      }),
    },
    {
      title: 'Доступные для подключения услуги',
      endpoint: 'GET /Product/ProductInfo (service, create)',
      run: () => client.raw('get', '/Product/ProductInfo', {
        accountId: aid,
        params: {
          'category.name': 'MobileConnectivity',
          'marketSegment.characteristic.name': 'MSISDN',
          'marketSegment.characteristic.value': msisdn,
          'productOffering.actionAllowed': 'create',
          'productSpecificationType.name': 'service',
          fields: 'CalculatePrices',
        },
      }),
    },
    {
      title: 'Подключённые блокировки',
      endpoint: 'GET /Product/ProductInfo (block, none)',
      run: () => client.raw('get', '/Product/ProductInfo', {
        accountId: aid,
        params: {
          'category.name': 'MobileConnectivity',
          'marketSegment.characteristic.name': 'MSISDN',
          'marketSegment.characteristic.value': msisdn,
          'productOffering.actionAllowed': 'none',
          'productSpecificationType.name': 'block',
          fields: 'CalculatePrices',
        },
      }),
    },
    {
      title: 'Доступные блокировки',
      endpoint: 'GET /Product/ProductInfo (block, create)',
      run: () => client.raw('get', '/Product/ProductInfo', {
        accountId: aid,
        params: {
          'category.name': 'MobileConnectivity',
          'marketSegment.characteristic.name': 'MSISDN',
          'marketSegment.characteristic.value': msisdn,
          'productOffering.actionAllowed': 'create',
          'productSpecificationType.name': 'block',
          fields: 'CalculatePrices',
        },
      }),
    },
    {
      title: 'Тарифы, доступные для перехода',
      endpoint: 'GET /Product/ProductInfo (AvailibleTariffPlann)',
      run: () => client.raw('get', '/Product/ProductInfo', {
        accountId: aid,
        params: {
          'marketSegment.characteristic.name': 'MSISDN',
          'marketSegment.characteristic.value': msisdn,
          'category.name': 'AvailibleTariffPlann', // опечатка на стороне МТС — так в доке
          fields: 'productOffering.externalId,productOffering.productOfferingPrice.price',
        },
      }),
    },
    {
      title: 'Правила переадресации',
      endpoint: 'GET /Product/CallForwardingInfo',
      run: () => client.raw('get', '/Product/CallForwardingInfo', {
        accountId: aid,
        params: {
          'productCharacteristic.name': 'MSISDN',
          'productCharacteristic.value': msisdn,
          'productLine.name': 'CallForwarding',
        },
      }),
    },
    {
      title: 'Роуминг / текущая локация SIM',
      endpoint: 'GET /Service/CurrentSubscriberLocation',
      run: () => client.raw('get', '/Service/CurrentSubscriberLocation', { accountId: aid, params: { msisdn } }),
    },
    {
      title: 'Способ доставки счетов',
      endpoint: 'GET /Bills/DocumentDeliveryMethodByMSISDN',
      run: () => client.raw('get', '/Bills/DocumentDeliveryMethodByMSISDN', {
        accountId: aid,
        params: {
          'customer.relatedParty.characteristic.name': 'MSISDN',
          'customer.relatedParty.characteristic.value': msisdn,
          'productRelationship.productLine.name': 'BillDeliveries',
        },
      }),
    },
    {
      title: `История платежей (пополнения) с ${payFrom}`,
      endpoint: 'GET /Bills/PaymentHistoryByMSISDN',
      // API требует yyyy-MM-dd'T'HH:mm:ssXXX (ответ 400 на голую дату).
      run: () => client.raw('get', '/Bills/PaymentHistoryByMSISDN', {
        accountId: aid,
        params: { msisdn, dateFrom: `${payFrom}T00:00:00+03:00`, dateTo: `${today}T23:59:59+03:00` },
      }),
    },
    {
      title: `Выписка по номеру с ${stmtFrom}`,
      endpoint: 'GET /Bills/BillingStatementByMSISDN',
      run: () => client.raw('get', '/Bills/BillingStatementByMSISDN', {
        accountId: aid,
        params: { msisdn, startDateTime: `${stmtFrom}T00:00:00Z`, endDateTime: `${today}T23:59:59Z` },
      }),
    },
    {
      title: `Расширенная выписка (детализация) с ${stmtFrom}`,
      endpoint: 'GET /Bills/BillingStatementExtdByMSISDN',
      run: () => client.raw('get', '/Bills/BillingStatementExtdByMSISDN', {
        accountId: aid,
        params: { msisdn, startDateTime: `${stmtFrom}T00:00:00Z`, endDateTime: `${today}T23:59:59Z` },
      }),
    },
    {
      title: 'Заявки (асинхронные операции) по номеру за сегодня',
      endpoint: 'POST /Product/CheckRequestStatus',
      run: () => client.raw('post', '/Product/CheckRequestStatus', {
        accountId: aid,
        data: {
          relatedParty: [{ characteristic: [{ name: 'MSISDN', value: msisdn }] }],
          validFor: { startDateTime: `${today}T00:00:00`, endDateTime: `${today}T23:59:59` },
        },
      }),
    },
    {
      title: 'Остатки пакетов (вариант из доки: номер в customerAccount.accountNo)',
      endpoint: 'GET /Bills/ValidityInfo (msisdn)',
      run: () => client.raw('get', '/Bills/ValidityInfo', {
        accountId: aid,
        params: {
          'customerAccount.accountNo': msisdn,
          'customerAccount.productRelationship.product.productLine.name': 'Counters',
          fields: 'MOAF',
        },
      }),
    },
  ];

  // ---------- прогон ----------
  const results: IProbeResult[] = [];
  let accountNo: string | null = ctxAccountNo || account?.accountNumber || null;

  const runProbe = async (def: IProbeDef, idx: number, total: number): Promise<void> => {
    console.log(`\n── [${idx}/${total}] ${def.title}`);
    console.log(`   ${def.endpoint}`);
    const t0 = Date.now();
    try {
      const data = await def.run();
      const ms = Date.now() - t0;
      const empty = isEmptyData(data);
      results.push({ title: def.title, endpoint: def.endpoint, outcome: { kind: empty ? 'empty' : 'data', ms, data } });
      console.log(`   ${empty ? '⊘ пусто' : '✓ данные'} · ${ms}ms · ${describe(data)}`);
      if (!empty) {
        const shown = full ? data : (def.pii ? maskPii(data) : maskEmails(data));
        let text = '';
        try { text = JSON.stringify(shown); } catch { text = String(shown); }
        console.log(`   ${text.slice(0, snippetLimit)}${text.length > snippetLimit ? ` …(усечено, всего ${text.length} зн.)` : ''}`);
      }
    } catch (e) {
      const ms = Date.now() - t0;
      if (isFeatureUnavailable(e)) {
        results.push({ title: def.title, endpoint: def.endpoint, outcome: { kind: 'unavailable', ms } });
        console.log(`   — не подключено в тарифе/подписке (403/1010) · ${ms}ms`);
      } else if (e instanceof MtsBusinessApiError) {
        results.push({
          title: def.title,
          endpoint: def.endpoint,
          outcome: { kind: 'error', ms, message: e.message, status: e.status, code: e.code },
        });
        console.log(`   ✗ HTTP ${e.status}${e.code ? ` code=${e.code}` : ''} · ${ms}ms · ${e.message}`);
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        results.push({ title: def.title, endpoint: def.endpoint, outcome: { kind: 'error', ms, message: msg } });
        console.log(`   ✗ ${msg} · ${ms}ms`);
      }
    }
  };

  // Пробы уровня ЛС добавляются после иерархии (оттуда берём accountNo).
  const accountProbes = (no: string): IProbeDef[] => [
    {
      title: `Баланс лицевого счёта ${no}`,
      endpoint: 'GET /Bills/CheckBalanceByAccount',
      run: () => client.raw('get', '/Bills/CheckBalanceByAccount', { accountId: aid, params: { accountNo: no } }),
    },
    {
      title: `Остатки пакетов по ЛС ${no}`,
      endpoint: 'GET /Bills/ValidityInfo (accountNo)',
      run: () => client.raw('get', '/Bills/ValidityInfo', {
        accountId: aid,
        params: {
          'customerAccount.accountNo': no,
          'customerAccount.productRelationship.product.productLine.name': 'Counters',
          fields: 'MOAF',
        },
      }),
    },
    {
      title: `Неоплаченные счета по ЛС ${no}`,
      endpoint: 'POST /Bills/GetUnpaidAmountByAccountNumber',
      // Тело как в доке МТС: голый массив номеров ЛС (сервис шлёт {data:[...]}).
      run: () => client.raw('post', '/Bills/GetUnpaidAmountByAccountNumber', { accountId: aid, data: [no] }),
    },
    {
      title: `Комментарий лицевого счёта ${no}`,
      endpoint: 'POST /Service/GetCommentsByAccount',
      pii: true,
      run: () => client.raw('post', '/Service/GetCommentsByAccount', { accountId: aid, data: { accounts: [no] } }),
    },
  ];

  // Сначала иерархия — из неё accountNo для проб уровня ЛС.
  await runProbe(probes[0], 1, probes.length);
  const hierOutcome = results[0]?.outcome;
  if (hierOutcome && (hierOutcome.kind === 'data' || hierOutcome.kind === 'empty')) {
    const node = collectNumberNodes(hierOutcome.data).find(
      n => normalizeMsisdn(String(n.productSerialNumber ?? '')) === msisdn,
    );
    const fromNode = node
      ? String(node.accountNo ?? node.account ?? node.accountNumber ?? '').trim()
      : '';
    if (fromNode) accountNo = fromNode;
  }

  const tail = probes.slice(1);
  const extra = accountNo ? accountProbes(accountNo) : [];
  const total = 1 + tail.length + extra.length;
  let idx = 1;
  for (const def of [...tail, ...extra]) {
    idx += 1;
    await runProbe(def, idx, total);
  }
  if (!accountNo) {
    console.log('\n(Лицевой счёт номера не определён — пробы уровня ЛС пропущены: CheckBalanceByAccount, ValidityInfo, GetUnpaidAmount, GetCommentsByAccount)');
    for (const def of accountProbes('—')) {
      results.push({ title: def.title, endpoint: def.endpoint, outcome: { kind: 'skipped', reason: 'ЛС не определён' } });
    }
  }

  // ---------- итог ----------
  const icon = (o: ProbeOutcome): string =>
    o.kind === 'data' ? '✓' : o.kind === 'empty' ? '⊘' : o.kind === 'unavailable' ? '—' : o.kind === 'skipped' ? '·' : '✗';
  const counts = { data: 0, empty: 0, unavailable: 0, error: 0, skipped: 0 };
  for (const r of results) counts[r.outcome.kind] += 1;

  console.log(`\n\n=== ИТОГ: ${msisdnMasked}, аккаунт «${account?.label ?? aid}» ===`);
  console.log(`✓ данные: ${counts.data}   ⊘ пусто: ${counts.empty}   — не подключено: ${counts.unavailable}   ✗ ошибки: ${counts.error}   · пропущено: ${counts.skipped}`);
  for (const r of results) {
    const o = r.outcome;
    const note =
      o.kind === 'data' ? describe(o.data)
      : o.kind === 'error' ? `HTTP ${o.status ?? '-'}${o.code ? ` code=${o.code}` : ''}`
      : o.kind === 'skipped' ? o.reason
      : '';
    console.log(`${icon(o)} ${r.title}${note ? ` — ${note}` : ''}`);
  }

  if (writeDump) {
    const dir = path.resolve(__dirname, '../tmp');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `mts-probe-${msisdn}-${stamp()}.json`);
    const dump = {
      msisdn,
      accountId: aid,
      accountLabel: account?.label ?? null,
      accountNo,
      generatedAt: new Date().toISOString(),
      statementWindowDays: days,
      probes: results.map(r => ({ title: r.title, endpoint: r.endpoint, ...r.outcome })),
    };
    fs.writeFileSync(file, JSON.stringify(dump, null, 2), 'utf8');
    console.log(`\nПолный сырой дамп: ${file}`);
    console.log('ВНИМАНИЕ: файл содержит ПДн (ФИО/PersonalData) — не коммитить и не пересылать. Папка fot-server/tmp/ в .gitignore.');
  }

  process.exit(counts.error > 0 && counts.data === 0 ? 2 : 0);
};

void main().catch(err => {
  console.error('Проба упала:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
