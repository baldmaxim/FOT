import { mtsBusinessBillingService } from './mts-business-billing.service.js';
import { mtsBusinessCatalogService } from './mts-business-catalog.service.js';
import { mtsBusinessMetricsStoreService, type MtsBusinessSnapshotMetric } from './mts-business-metrics-store.service.js';
import { mtsBusinessPersonalDataService } from './mts-business-personal-data.service.js';
import { mtsBusinessMappingService } from './mts-business-mapping.service.js';
import { msisdnHash } from './mts-business-cdr.service.js';
import {
  isFeatureUnavailable,
  isMtsUpstreamSoftError,
  isTransientMtsError,
  MtsBusinessApiError,
  mtsErrorBucket,
  mtsPermanentErrorKind,
} from './mts-business-base.service.js';

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
  /** Класс ошибки для сводок (mtsErrorBucket): «http 500/9999», «сеть/таймаут», «другое». */
  bucket: string;
}

export interface ISubscriberSyncResult {
  msisdn: string;
  sections: number;
  stored: number;
  unavailable: number; // 403/1010 — не подключено в тарифе МТС
  failed: number;
  transient: number; // 421/3003 — Foris временно недоступен
  /** Секций со стабильным состоянием номера: 401/1014, 422/2005, 404. */
  noAccess: number;
  noBinding: number;
  noData: number;
  /** Секций с точечным сбоем бэкенда МТС (400/IL.*) — не наша вина, не сбой прогона. */
  mtsError: number;
  errors: ISubscriberSyncSectionError[];
}

export interface ISubscriberSyncOptions {
  mode?: 'bulk' | 'full';
  /** Пропустить PersonalDataInfo (статус свежий — жалеем rate-limit). */
  skipPd?: boolean;
  /** Выполнить только эти секции (повтор упавших — не жжём лимит на успешных). */
  onlySections?: ReadonlySet<string>;
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
    msisdn, sections: 0, stored: 0, unavailable: 0, failed: 0, transient: 0,
    noAccess: 0, noBinding: 0, noData: 0, mtsError: 0, errors: [],
  };
  const settle = async (section: string, fn: () => Promise<void>): Promise<void> => {
    if (options.onlySections && !options.onlySections.has(section)) return;
    result.sections++;
    try {
      await fn();
      result.stored++;
    } catch (e) {
      const apiErr = e instanceof MtsBusinessApiError ? e : null;
      const permanent = mtsPermanentErrorKind(e);
      if (isFeatureUnavailable(e)) {
        result.unavailable++;
      } else if (permanent === 'no_access') {
        result.noAccess++;
      } else if (permanent === 'no_binding') {
        result.noBinding++;
      } else if (permanent === 'no_data') {
        result.noData++;
      } else if (isMtsUpstreamSoftError(e)) {
        // 400/IL.* — точечный сбой биллинга МТС. В errors НЕ кладём: повтор
        // бесполезен (400 стабилен), второй проход его не трогает.
        result.mtsError++;
        console.warn(
          `[mts-biz-subscribers] section=${section} msisdn=${msisdn} http=${apiErr!.status} code=${apiErr!.code ?? '-'} mts-error`,
        );
      } else if (isTransientMtsError(e)) {
        result.transient++;
        result.errors.push({ section, status: apiErr!.status, code: apiErr!.code, kind: 'transient', bucket: mtsErrorBucket(e) });
        console.warn(
          `[mts-biz-subscribers] section=${section} msisdn=${msisdn} http=${apiErr!.status} code=${apiErr!.code ?? '-'} transient`,
        );
      } else {
        result.failed++;
        result.errors.push({ section, status: apiErr?.status ?? 0, code: apiErr?.code, kind: 'failed', bucket: mtsErrorBucket(e) });
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
  transient: number; // секций 421/3003 даже после повтора
  pdSkipped: number; // персданные свежие — вызов сэкономлен
  retriedNumbers: number; // номеров ушло на второй проход
  retriedOk: number; // из них полностью добрано повтором
  /** НОМЕРОВ со стабильным состоянием (не сбой прогона): вне доступа
   *  портального пользователя (401/1014), без связки региона/ТП (422/2005),
   *  без заведённых персданных (404). */
  noAccessNumbers: number;
  noBindingNumbers: number;
  noPdNumbers: number;
  /** Секций с точечным сбоем бэкенда МТС (400/IL.*) — не сбой прогона. */
  mtsErrorSections: number;
  /** Класс ошибки → количество, только окончательно упавшие секции (kind=failed). */
  errorBreakdown: Record<string, number>;
}

const PD_FRESH_HOURS = 24;
const SYNC_POOL = 3;

/**
 * Bulk-синк всех известных номеров аккаунта (шаг «Полные профили абонентов»).
 * Пул из 3 воркеров: упираемся в rate-gate аккаунта, а не в RTT последовательных
 * вызовов; персданные со свежим статусом (<24ч) пропускаются. По номерам с
 * упавшими секциями — ВТОРОЙ проход (последовательно, только упавшие секции):
 * ночные 500/таймауты МТС обычно добираются повтором. 403/1010 не повторяем.
 */
export async function syncAccountSubscribers(accountId: string): Promise<IAccountSubscribersSyncResult> {
  const msisdns = await mtsBusinessMappingService.getAllKnownMsisdnsByAccount(accountId);
  const freshPd = await mtsBusinessMappingService.getFreshPdHashes(PD_FRESH_HOURS);
  const out: IAccountSubscribersSyncResult = {
    accountId, numbers: msisdns.length, stored: 0, unavailable: 0, failed: 0, transient: 0,
    pdSkipped: 0, retriedNumbers: 0, retriedOk: 0,
    noAccessNumbers: 0, noBindingNumbers: 0, noPdNumbers: 0, mtsErrorSections: 0, errorBreakdown: {},
  };

  const results = new Map<string, ISubscriberSyncResult>();
  await runPool(msisdns, SYNC_POOL, async msisdn => {
    const hash = msisdnHash(msisdn);
    const skipPd = hash != null && freshPd.has(hash);
    if (skipPd) out.pdSkipped++;
    results.set(msisdn, await syncSubscriberFull(accountId, msisdn, { mode: 'bulk', skipPd }));
  });

  for (const [msisdn, first] of results) {
    const retrySections = new Set(first.errors.map(e => e.section));
    if (retrySections.size === 0) continue;
    out.retriedNumbers++;
    const retry = await syncSubscriberFull(accountId, msisdn, {
      mode: 'bulk',
      skipPd: !retrySections.has('personal_data'),
      onlySections: retrySections,
    });
    // Итог номера: успехи обоих проходов, ошибки — только со второго
    // (повторялись ровно упавшие секции, их прежний исход перекрыт).
    first.stored += retry.stored;
    first.unavailable += retry.unavailable;
    first.failed = retry.failed;
    first.transient = retry.transient;
    // mtsError-секции первого прохода не повторялись (не в errors) — их счётчик
    // сохраняем; повтор мог дать новые 400/IL.* на ранее упавших секциях.
    first.mtsError += retry.mtsError;
    first.errors = retry.errors;
    if (retry.failed === 0 && retry.transient === 0) out.retriedOk++;
  }

  for (const r of results.values()) {
    out.stored += r.stored;
    out.unavailable += r.unavailable;
    out.failed += r.failed;
    out.transient += r.transient;
    if (r.noAccess > 0) out.noAccessNumbers++;
    if (r.noBinding > 0) out.noBindingNumbers++;
    if (r.noData > 0) out.noPdNumbers++;
    out.mtsErrorSections += r.mtsError;
    for (const e of r.errors) {
      if (e.kind !== 'failed') continue;
      out.errorBreakdown[e.bucket] = (out.errorBreakdown[e.bucket] ?? 0) + 1;
    }
  }

  console.log(
    `[mts-biz-subscribers] account=${accountId} numbers=${out.numbers} stored=${out.stored} unavailable=${out.unavailable}`
    + ` failed=${out.failed} transient=${out.transient} mtsError=${out.mtsErrorSections} noAccess=${out.noAccessNumbers} noBinding=${out.noBindingNumbers}`
    + ` noPd=${out.noPdNumbers} retried=${out.retriedNumbers} retriedOk=${out.retriedOk} pdSkipped=${out.pdSkipped}`,
  );
  return out;
}
