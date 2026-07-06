/**
 * Проба: где в СИНХРОННОМ МТС Бизнес API лежат ТЕКУЩИЙ тариф (имя), абонплата и
 * начисления по номеру (READ-ONLY, ничего не пишет в БД/МТС).
 *
 * Зачем: у всех номеров поля «Тариф»/«Абонентская плата»/«Начисления» в карточке
 * пусты. Проверено на БД:
 *   - bill_plan.tariffName = null во ВСЕХ снапшотах (Product/BillPlanInfo, fields=MOAF);
 *   - tariff_fee не сохраняется ни разу (Bills/TariffRental падает);
 *   - charges_amount в bulk-режиме «Обновить всё» не вызывается вовсе.
 * Ищем рабочую ручку/параметры, откуда взять имя тарифа + абонплату + начисления.
 *
 * Кандидаты:
 *   [1] Product/BillPlanInfo — текущие params (fields=MOAF) и варианты fields;
 *   [2] Product/ProductInfo с productSpecificationType.name=tariff|ratePlan,
 *       actionAllowed=none — подключённый тариф как позиция (имя + PeriodicalPrice);
 *   [3] Bills/TariffRental — причина падения (сырое тело ошибки);
 *   [4] Bills/CheckCharges — начисления по номеру (bulk на 1 номер).
 *
 * Запуск на проде (accountId резолвится по номеру, .env берётся из папки сайта):
 *   cd /opt/fot-build && MTS_PROBE_RAW=1 npx tsx fot-server/scripts/probe-mts-business-tariff.ts <msisdn>
 * Если .env в нестандартном месте: MTS_ENV_FILE=/путь/.env MTS_PROBE_RAW=1 npx tsx ...
 *
 * Значения полей-имён маскируются (первая буква + ***). Сырые тела дублируются
 * логом [mts-raw] базового клиента (флаг MTS_PROBE_RAW=1).
 */
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

const NAME_KEYS = new Set(['fio', 'name', 'organizationName', 'label', 'alias', 'subscriberName', 'ownerName']);
const maskPii = (v: unknown, key?: string): unknown => {
  if (typeof v === 'string') {
    let s = v.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '***@***');
    // Имя тарифа/услуги НЕ маскируем — оно нам и нужно; маскируем только орг/ФИО.
    if (key && (key === 'organizationName' || key === 'fio' || key === 'subscriberName' || key === 'ownerName') && s.length > 1) s = `${s[0]}***`;
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

const short = (v: unknown, n = 3000): string => JSON.stringify(maskPii(v)).slice(0, n);
const errMsg = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

const main = async (): Promise<void> => {
  const [msisdn] = process.argv.slice(2);
  if (!msisdn) {
    console.error('Использование: probe-mts-business-tariff.ts <msisdn>');
    process.exit(1);
  }

  const { MtsBusinessServiceBase } = await import('../src/services/mts-business-base.service.js');
  const { mtsBusinessCatalogService } = await import('../src/services/mts-business-catalog.service.js');
  const { mtsBusinessBillingService } = await import('../src/services/mts-business-billing.service.js');
  const { mtsBusinessMappingService } = await import('../src/services/mts-business-mapping.service.js');

  // Подкласс для сырых вызовов с произвольными params (request() — protected).
  class Probe extends MtsBusinessServiceBase {
    raw(endpoint: string, accountId: string, params: Record<string, unknown>): Promise<unknown> {
      return this.request('get', endpoint, { accountId, params });
    }
  }
  const probe = new Probe();

  const ctx = await mtsBusinessMappingService.getSubscriberContext(msisdn);
  if (!ctx) {
    console.error('Номер не привязан к аккаунту (нет account_id) — сначала прогони backfill.');
    process.exit(1);
  }
  const { accountId } = ctx;
  console.log(`Проба ТАРИФА: account=${accountId} msisdn=${msisdn.slice(0, 4)}***${msisdn.slice(-2)}`);

  // [1] BillPlanInfo — текущий парсер + варианты fields.
  console.log('\n=== [1] Product/BillPlanInfo ===');
  try {
    const parsed = await mtsBusinessCatalogService.getBillPlanInfo(accountId, msisdn);
    console.log('парсер getBillPlanInfo →', short(parsed));
  } catch (e) { console.log('getBillPlanInfo ОШИБКА:', errMsg(e)); }
  for (const fields of ['MOAF', 'productOffering', 'productOffering.name', 'CalculatePrices', 'ProductOfferingQualification']) {
    try {
      const r = await probe.raw('/Product/BillPlanInfo', accountId, {
        'productCharacteristic.name': 'MSISDN',
        'productCharacteristic.value': msisdn,
        'productLine.name': 'MobileConnectivity',
        fields,
      });
      console.log(`  fields=${fields} → тип=${Array.isArray(r) ? 'array' : typeof r} ${short(r, 1500)}`);
    } catch (e) { console.log(`  fields=${fields} ОШИБКА:`, errMsg(e)); }
  }

  // [2] ProductInfo с productSpecificationType.name = tariff|ratePlan (подключённый).
  console.log('\n=== [2] Product/ProductInfo (specType tariff/ratePlan, actionAllowed=none) ===');
  for (const specType of ['tariff', 'ratePlan', 'BillPlan', 'tariffPlan']) {
    try {
      const r = await probe.raw('/Product/ProductInfo', accountId, {
        'category.name': 'MobileConnectivity',
        'marketSegment.characteristic.name': 'MSISDN',
        'marketSegment.characteristic.value': msisdn,
        'productOffering.actionAllowed': 'none',
        'productSpecificationType.name': specType,
        fields: 'CalculatePrices',
      });
      console.log(`  specType=${specType} → ${short(r, 2500)}`);
    } catch (e) { console.log(`  specType=${specType} ОШИБКА:`, errMsg(e)); }
  }

  // [3] Bills/TariffRental — причина падения (сырое тело ошибки видно в [mts-biz] upstream body).
  console.log('\n=== [3] Bills/TariffRental ===');
  try {
    const fee = await mtsBusinessBillingService.getTariffRental(accountId, msisdn);
    console.log('парсер getTariffRental →', short(fee));
  } catch (e) { console.log('getTariffRental ОШИБКА:', errMsg(e)); }

  // [4] Bills/CheckCharges — начисления по номеру.
  console.log('\n=== [4] Bills/CheckCharges ===');
  try {
    const charges = await mtsBusinessBillingService.checkChargesBulk(accountId, [msisdn]);
    console.log('checkChargesBulk →', short(charges));
  } catch (e) { console.log('checkChargesBulk ОШИБКА:', errMsg(e)); }

  process.exit(0);
};

void main().catch(err => {
  console.error('Проба упала:', errMsg(err));
  process.exit(1);
});
