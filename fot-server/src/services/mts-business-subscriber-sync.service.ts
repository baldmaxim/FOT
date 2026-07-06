import { mtsBusinessBillingService } from './mts-business-billing.service.js';
import { mtsBusinessCatalogService } from './mts-business-catalog.service.js';
import { mtsBusinessMetricsStoreService, type MtsBusinessSnapshotMetric } from './mts-business-metrics-store.service.js';
import { mtsBusinessPersonalDataService } from './mts-business-personal-data.service.js';
import { mtsBusinessMappingService } from './mts-business-mapping.service.js';
import { isFeatureUnavailable } from './mts-business-base.service.js';

// Полная выгрузка профиля абонента (как probe-mts-number-all.ts, но в БД):
// персданные (ФИО/статус открыто, сырой ответ — шифром), баланс/начисления
// (дневные метрики), тариф/абонплата/услуги/блокировки/переадресация/роуминг/
// доставка/платежи/пакеты (снапшоты scope='msisdn'). ~12 вызовов на номер через
// общий rate-gate аккаунта; одна упавшая секция не роняет остальные.

export interface ISubscriberSyncResult {
  msisdn: string;
  sections: number;
  stored: number;
  unavailable: number; // 403/1010 — не подключено в тарифе МТС
  failed: number;
}

const isoDay = (offsetDays: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};

export async function syncSubscriberFull(accountId: string, msisdn: string): Promise<ISubscriberSyncResult> {
  const result: ISubscriberSyncResult = { msisdn, sections: 0, stored: 0, unavailable: 0, failed: 0 };
  const settle = async (fn: () => Promise<void>): Promise<void> => {
    result.sections++;
    try {
      await fn();
      result.stored++;
    } catch (e) {
      if (isFeatureUnavailable(e)) result.unavailable++;
      else result.failed++;
    }
  };
  const snap = (metric: MtsBusinessSnapshotMetric, payload: unknown): Promise<void> =>
    mtsBusinessMetricsStoreService.upsertSnapshot({ accountId, scope: 'msisdn', msisdn, metric, payload });

  // Персональные данные: ФИО → mts_fio (+автопривязка), статус → pd_status,
  // полный ответ (паспорт и пр.) → pd_data_enc шифром, наружу не отдаётся.
  await settle(async () => {
    const info = await mtsBusinessPersonalDataService.fetchAndStoreFull(accountId, msisdn);
    if (info.fullName) await mtsBusinessMappingService.syncMtsNames([{ msisdn, fio: info.fullName }], null);
  });

  // Баланс/начисления — в те же дневные метрики, что пишет refreshAccountMetrics.
  await settle(async () => {
    const balance = await mtsBusinessBillingService.checkBalanceByMsisdn(accountId, msisdn);
    if (balance.amount != null) {
      await mtsBusinessMetricsStoreService.upsertDaily({
        accountId, scope: 'msisdn', msisdn, metric: 'balance',
        amount: balance.amount, currencyCode: balance.currencyCode, validTo: balance.validUntil,
      });
    }
  });
  await settle(async () => {
    const charges = await mtsBusinessBillingService.checkChargesBulk(accountId, [msisdn]);
    const c = charges[0];
    if (c?.amount != null) {
      await mtsBusinessMetricsStoreService.upsertDaily({
        accountId, scope: 'msisdn', msisdn, metric: 'charges_amount',
        amount: c.amount, validFrom: c.periodStart, validTo: c.periodEnd,
      });
    }
  });

  await settle(async () => snap('bill_plan', await mtsBusinessCatalogService.getBillPlanInfo(accountId, msisdn)));
  await settle(async () => snap('tariff_fee', await mtsBusinessBillingService.getTariffRental(accountId, msisdn)));
  await settle(async () => snap('product_services', await mtsBusinessCatalogService.getProductInfo(accountId, msisdn)));
  await settle(async () => snap('connected_blocks', await mtsBusinessCatalogService.getConnectedBlocks(accountId, msisdn)));
  await settle(async () => snap('forwarding', await mtsBusinessCatalogService.getCallForwarding(accountId, msisdn)));
  await settle(async () => snap('roaming', await mtsBusinessCatalogService.getCurrentSubscriberLocation(accountId, msisdn)));
  await settle(async () => snap('delivery_method', await mtsBusinessBillingService.getDocumentDeliveryMethod(accountId, msisdn)));
  await settle(async () => snap('payments', await mtsBusinessBillingService.getPaymentHistoryByMsisdn(accountId, msisdn, isoDay(-30), isoDay(0))));
  // Остатки пакетов ПО НОМЕРУ: тот же ValidityInfo, но в customerAccount.accountNo
  // передаётся MSISDN (подтверждено probe 06.07.2026: по номеру — данные, по ЛС — 401).
  await settle(async () => snap('validity_msisdn', await mtsBusinessBillingService.getValidityInfo(accountId, msisdn)));

  return result;
}

export interface IAccountSubscribersSyncResult {
  accountId: string;
  numbers: number;
  stored: number;
  unavailable: number;
  failed: number;
}

/** Полный синк всех известных номеров аккаунта (шаг «Абоненты» оркестратора «Обновить всё»). */
export async function syncAccountSubscribers(accountId: string): Promise<IAccountSubscribersSyncResult> {
  const msisdns = await mtsBusinessMappingService.getAllKnownMsisdnsByAccount(accountId);
  const out: IAccountSubscribersSyncResult = { accountId, numbers: msisdns.length, stored: 0, unavailable: 0, failed: 0 };
  for (const msisdn of msisdns) {
    const r = await syncSubscriberFull(accountId, msisdn);
    out.stored += r.stored;
    out.unavailable += r.unavailable;
    out.failed += r.failed;
  }
  console.log(`[mts-biz-subscribers] account=${accountId} numbers=${out.numbers} stored=${out.stored} unavailable=${out.unavailable} failed=${out.failed}`);
  return out;
}
