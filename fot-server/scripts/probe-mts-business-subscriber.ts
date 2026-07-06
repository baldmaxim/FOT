/**
 * Проба новых read-only эндпоинтов «карточки номера» МТС Business API (READ-ONLY).
 *
 * Зачем: контракты TariffRental / PaymentHistory / DocumentDeliveryMethod /
 * BillingStatement / ProductInfo(available|blocks|tariffs) / CallForwardingInfo /
 * CurrentSubscriberLocation и расширенный HierarchyStructure НЕ проверены живым
 * вызовом. Скрипт дёргает каждый по одному разу для реального номера и печатает
 * распарсенный результат — видно, заполнились ли поля (иначе форма ответа МТС
 * расходится с парсером, как уже бывало с Documents/Bills по датам/регистру).
 *
 * Запуск (в прод-контексте сборки, где .env корректен — /opt/fot-build):
 *   npx tsx fot-server/scripts/probe-mts-business-subscriber.ts <accountId> <msisdn> [YYYY-MM]
 *
 * Ничего не пишет в БД/МТС. ПДн (ФИО/email) в выводе маскируются. Дампы НЕ
 * коммитить. См. план zany-juggling-quasar / [[reference_vps_oneoff_tsx_scripts]].
 */
import { mtsBusinessBillingService } from '../src/services/mts-business-billing.service.js';
import { mtsBusinessCatalogService } from '../src/services/mts-business-catalog.service.js';
import { mtsBusinessDataService } from '../src/services/mts-business-data.service.js';
import { mtsBusinessSubscriberCardService } from '../src/services/mts-business-subscriber-card.service.js';

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

const show = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
  try {
    const res = await fn();
    console.log(`\n=== ${label} ===`);
    console.log(JSON.stringify(maskPii(res), null, 2));
  } catch (e) {
    console.log(`\n=== ${label} === ОШИБКА: ${e instanceof Error ? e.message : String(e)}`);
  }
};

const main = async (): Promise<void> => {
  const [accountId, msisdn, month] = process.argv.slice(2);
  if (!accountId || !msisdn) {
    console.error('Использование: probe-mts-business-subscriber.ts <accountId> <msisdn> [YYYY-MM]');
    process.exit(1);
  }
  console.log(`Проба МТС Бизнес: account=${accountId} msisdn=${msisdn.slice(0, 4)}***${msisdn.slice(-2)}`);

  await show('TariffRental', () => mtsBusinessBillingService.getTariffRental(accountId, msisdn));
  await show('DocumentDeliveryMethodByMSISDN', () => mtsBusinessBillingService.getDocumentDeliveryMethod(accountId, msisdn));
  await show('AvailableServices (ProductInfo actionAllowed=create/service)', () => mtsBusinessCatalogService.getAvailableServices(accountId, msisdn));
  await show('ConnectedBlocks (ProductInfo actionAllowed=none/block)', () => mtsBusinessCatalogService.getConnectedBlocks(accountId, msisdn));
  await show('AvailableBlocks (ProductInfo actionAllowed=create/block)', () => mtsBusinessCatalogService.getAvailableBlocks(accountId, msisdn));
  await show('AvailableTariffs (ProductInfo category=AvailibleTariffPlann)', () => mtsBusinessCatalogService.getAvailableTariffs(accountId, msisdn));
  await show('CallForwardingInfo', () => mtsBusinessCatalogService.getCallForwarding(accountId, msisdn));
  await show('CurrentSubscriberLocation', () => mtsBusinessCatalogService.getCurrentSubscriberLocation(accountId, msisdn));
  await show('HierarchyStructure (расширенный parseHierarchy — IMSI/SIM/ИНН/КПП)', () => mtsBusinessCatalogService.getHierarchyStructure(accountId));

  const m = month && /^\d{4}-\d{2}$/.test(month) ? month : new Date().toISOString().slice(0, 7);
  await show(`Card (сборка карточки)`, () => mtsBusinessSubscriberCardService.getCard(msisdn));
  await show(`Expenses ${m}`, () => mtsBusinessSubscriberCardService.getExpenses(msisdn, m));

  process.exit(0);
};

void main();
