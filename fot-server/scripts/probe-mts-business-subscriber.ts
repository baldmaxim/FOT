/**
 * Проба новых read-only эндпоинтов «карточки номера» МТС Business API (READ-ONLY).
 *
 * Зачем: контракты TariffRental / PaymentHistory / DocumentDeliveryMethod /
 * BillingStatement / ProductInfo(available|blocks|tariffs) / CallForwardingInfo /
 * CurrentSubscriberLocation / CheckCharges и расширенный HierarchyStructure НЕ
 * проверены живым вызовом. Скрипт дёргает каждый по разу для реального номера и
 * печатает распарсенный результат — видно, заполнились ли поля / какая ошибка
 * (401/421 и т.п.), чтобы поправить params/парсер.
 *
 * Запуск на проде (.env берём из папки сайта, грузим явно):
 *   cd /opt/fot-build/fot-server && npx tsx scripts/probe-mts-business-subscriber.ts <accountId> <msisdn> [YYYY-MM]
 * Если .env в нестандартном месте: MTS_ENV_FILE=/путь/.env npx tsx scripts/...
 *
 * Ничего не пишет в БД/МТС. ПДн (ФИО/email) в выводе маскируются. Дампы НЕ коммитить.
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

// Лёгкая маскировка ПДн в выводе: email и значения полей-имён.
const NAME_KEYS = new Set(['fio', 'name', 'organizationName', 'employeeFullName']);
const maskPii = (v: unknown, key?: string): unknown => {
  if (typeof v === 'string') {
    let s = v.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '***@***');
    if (key && NAME_KEYS.has(key) && s.length > 1) s = `${s[0]}***`;
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

const main = async (): Promise<void> => {
  const [accountId, msisdn, month] = process.argv.slice(2);
  if (!accountId || !msisdn) {
    console.error('Использование: probe-mts-business-subscriber.ts <accountId> <msisdn> [YYYY-MM]');
    process.exit(1);
  }

  const { mtsBusinessBillingService } = await import('../src/services/mts-business-billing.service.js');
  const { mtsBusinessCatalogService } = await import('../src/services/mts-business-catalog.service.js');
  const { mtsBusinessSubscriberCardService } = await import('../src/services/mts-business-subscriber-card.service.js');

  const show = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
    try {
      const res = await fn();
      console.log(`\n=== ${label} ===`);
      console.log(JSON.stringify(maskPii(res), null, 2));
    } catch (e) {
      console.log(`\n=== ${label} === ОШИБКА: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  console.log(`Проба МТС Бизнес: account=${accountId} msisdn=${msisdn.slice(0, 4)}***${msisdn.slice(-2)}`);

  await show('CheckChargesBulk (начисления)', () => mtsBusinessBillingService.checkChargesBulk(accountId, [msisdn]));
  await show('TariffRental', () => mtsBusinessBillingService.getTariffRental(accountId, msisdn));
  await show('DocumentDeliveryMethodByMSISDN', () => mtsBusinessBillingService.getDocumentDeliveryMethod(accountId, msisdn));
  await show('AvailableServices (ProductInfo actionAllowed=create/service)', () => mtsBusinessCatalogService.getAvailableServices(accountId, msisdn));
  await show('ConnectedBlocks (ProductInfo actionAllowed=none/block)', () => mtsBusinessCatalogService.getConnectedBlocks(accountId, msisdn));
  await show('AvailableTariffs (ProductInfo category=AvailibleTariffPlann)', () => mtsBusinessCatalogService.getAvailableTariffs(accountId, msisdn));
  await show('CallForwardingInfo', () => mtsBusinessCatalogService.getCallForwarding(accountId, msisdn));
  await show('CurrentSubscriberLocation', () => mtsBusinessCatalogService.getCurrentSubscriberLocation(accountId, msisdn));
  await show('HierarchyStructure (расширенный parseHierarchy — IMSI/SIM/ИНН/КПП)', () => mtsBusinessCatalogService.getHierarchyStructure(accountId));

  const m = month && /^\d{4}-\d{2}$/.test(month) ? month : new Date().toISOString().slice(0, 7);
  await show('Card (сборка карточки)', () => mtsBusinessSubscriberCardService.getCard(msisdn));
  await show(`Expenses ${m}`, () => mtsBusinessSubscriberCardService.getExpenses(msisdn, m));

  process.exit(0);
};

void main().catch(err => {
  console.error('Проба упала:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
