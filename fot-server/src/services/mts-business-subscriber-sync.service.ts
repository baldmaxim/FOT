import { mtsBusinessBillingService } from './mts-business-billing.service.js';
import { mtsBusinessCatalogService } from './mts-business-catalog.service.js';
import { mtsBusinessMetricsStoreService, type MtsBusinessSnapshotMetric } from './mts-business-metrics-store.service.js';
import { mtsBusinessPersonalDataService } from './mts-business-personal-data.service.js';
import { mtsBusinessMappingService } from './mts-business-mapping.service.js';
import { msisdnHash } from './mts-business-cdr.service.js';
import { isFeatureUnavailable, isTransientMtsError, MtsBusinessApiError } from './mts-business-base.service.js';

// Полная выгрузка профиля абонента (как probe-mts-number-all.ts, но в БД).
// Два режима — бюджет вызовов критичен (rate-limit 60/300 в мин на аккаунт,
// номеров ~1500):
//  - 'bulk' (шаг «Полные профили» оркестратора): только то, что видно в
//    списке/карточке по умолчанию — персданные (со skip по свежести),
//    тариф, абонплата, услуги, блокировки. ~5 вызовов на номер.
//  - 'full' (кнопка «Обновить данные из МТС» в карточке): + начисления,
//    переадресация, роуминг, доставка счетов, платежи 30д, пакеты. ~11 вызовов.
// Баланс по номеру НЕ выгружается вовсе: у номера нет своего баланса, метод
// возвращает общий баланс ЛС (он снимается в шаге «Балансы и начисления»).

export interface ISubscriberSyncSectionError {
  section: string;
  status: number;
  code?: string;
  kind: 'transient' | 'failed';
}

export interface ISubscriberSyncResult {
  msisdn: string;
  sections: number;
  stored: number;
  unavailable: number; // 403/1010 — не подключено в тарифе МТС
  failed: number;
  transient: number; // 421/3003 — Foris временно недоступен
  errors: ISubscriberSyncSectionError[];
}

export interface ISubscriberSyncOptions {
  mode?: 'bulk' | 'full';
  /** Пропустить PersonalDataInfo (статус свежий — жалеем rate-limit). */
  skipPd?: boolean;
}

const isoDay = (offsetDays: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};

/** Простой пул воркеров: не более `limit` одновременных задач. */
export const runPool = async <T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> => {
  let i = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const idx = i++;
      if (idx >= items.length) return;
      await worker(items[idx]);
    }
  });
  await Promise.all(runners);
};

export async function syncSubscriberFull(
  accountId: string,
  msisdn: string,
  options: ISubscriberSyncOptions = {},
): Promise<ISubscriberSyncResult> {
  const mode = options.mode ?? 'full';
  const result: ISubscriberSyncResult = {
    msisdn, sections: 0, stored: 0, unavailable: 0, failed: 0, transient: 0, errors: [],
  };
  const settle = async (section: string, fn: () => Promise<void>): Promise<void> => {
    result.sections++;
    try {
      await fn();
      result.stored++;
    } catch (e) {
      const apiErr = e instanceof MtsBusinessApiError ? e : null;
      if (isFeatureUnavailable(e)) {
        result.unavailable++;
      } else if (isTransientMtsError(e)) {
        result.transient++;
        result.errors.push({ section, status: apiErr!.status, code: apiErr!.code, kind: 'transient' });
        console.warn(
          `[mts-biz-subscribers] section=${section} msisdn=${msisdn} http=${apiErr!.status} code=${apiErr!.code ?? '-'} transient`,
        );
      } else {
        result.failed++;
        result.errors.push({ section, status: apiErr?.status ?? 0, code: apiErr?.code, kind: 'failed' });
        console.warn(
          `[mts-biz-subscribers] section=${section} msisdn=${msisdn} http=${apiErr?.status ?? 0} code=${apiErr?.code ?? '-'} failed`,
        );
      }
    }
  };
  const snap = (metric: MtsBusinessSnapshotMetric, payload: unknown): Promise<void> =>
    mtsBusinessMetricsStoreService.upsertSnapshot({ accountId, scope: 'msisdn', msisdn, metric, payload });

  // Персональные данные: ФИО → mts_fio (+автопривязка), статус → pd_status,
  // полный ответ (паспорт и пр.) → pd_data_enc шифром, наружу не отдаётся.
  if (!options.skipPd) {
    await settle('personal_data', async () => {
      const info = await mtsBusinessPersonalDataService.fetchAndStoreFull(accountId, msisdn);
      if (info.fullName) await mtsBusinessMappingService.syncMtsNames([{ msisdn, fio: info.fullName }], null);
    });
  }

  await settle('bill_plan', async () => snap('bill_plan', await mtsBusinessCatalogService.getBillPlanInfo(accountId, msisdn)));
  await settle('tariff_fee', async () => snap('tariff_fee', await mtsBusinessBillingService.getTariffRental(accountId, msisdn)));
  await settle('product_services', async () => snap('product_services', await mtsBusinessCatalogService.getProductInfo(accountId, msisdn)));
  await settle('connected_blocks', async () => snap('connected_blocks', await mtsBusinessCatalogService.getConnectedBlocks(accountId, msisdn)));

  if (mode === 'full') {
    // Начисления (charges_amount) здесь НЕ снимаем через CheckCharges: его
    // remainedAmount — остаток по ЛС, а не начисление на номер. Значение
    // charges_amount пишет выписка (syncMsisdnStatement → sumStatementCharges).
    await settle('forwarding', async () => snap('forwarding', await mtsBusinessCatalogService.getCallForwarding(accountId, msisdn)));
    await settle('roaming', async () => snap('roaming', await mtsBusinessCatalogService.getCurrentSubscriberLocation(accountId, msisdn)));
    await settle('delivery_method', async () => snap('delivery_method', await mtsBusinessBillingService.getDocumentDeliveryMethod(accountId, msisdn)));
    await settle('payments', async () => snap('payments', await mtsBusinessBillingService.getPaymentHistoryByMsisdn(accountId, msisdn, isoDay(-30), isoDay(0))));
    // Остатки пакетов ПО НОМЕРУ: тот же ValidityInfo, но в customerAccount.accountNo
    // передаётся MSISDN (подтверждено probe 06.07.2026: по номеру — данные, по ЛС — 401).
    await settle('validity_msisdn', async () => snap('validity_msisdn', await mtsBusinessBillingService.getValidityInfo(accountId, msisdn)));
  }

  return result;
}

export interface IAccountSubscribersSyncResult {
  accountId: string;
  numbers: number;
  stored: number;
  unavailable: number;
  failed: number;
  pdSkipped: number; // персданные свежие — вызов сэкономлен
}

const PD_FRESH_HOURS = 24;
const SYNC_POOL = 3;

/**
 * Bulk-синк всех известных номеров аккаунта (шаг «Полные профили абонентов»).
 * Пул из 3 воркеров: упираемся в rate-gate аккаунта, а не в RTT последовательных
 * вызовов; персданные со свежим статусом (<24ч) пропускаются.
 */
export async function syncAccountSubscribers(accountId: string): Promise<IAccountSubscribersSyncResult> {
  const msisdns = await mtsBusinessMappingService.getAllKnownMsisdnsByAccount(accountId);
  const freshPd = await mtsBusinessMappingService.getFreshPdHashes(PD_FRESH_HOURS);
  const out: IAccountSubscribersSyncResult = { accountId, numbers: msisdns.length, stored: 0, unavailable: 0, failed: 0, pdSkipped: 0 };

  await runPool(msisdns, SYNC_POOL, async msisdn => {
    const hash = msisdnHash(msisdn);
    const skipPd = hash != null && freshPd.has(hash);
    if (skipPd) out.pdSkipped++;
    const r = await syncSubscriberFull(accountId, msisdn, { mode: 'bulk', skipPd });
    out.stored += r.stored;
    out.unavailable += r.unavailable;
    out.failed += r.failed;
  });

  console.log(`[mts-biz-subscribers] account=${accountId} numbers=${out.numbers} stored=${out.stored} unavailable=${out.unavailable} failed=${out.failed} pdSkipped=${out.pdSkipped}`);
  return out;
}
