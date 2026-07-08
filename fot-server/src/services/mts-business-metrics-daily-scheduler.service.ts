import * as Sentry from '@sentry/node';
import { env } from '../config/env.js';
import { mtsBusinessAccountsService } from './mts-business-accounts.service.js';
import { mtsBusinessBillingService } from './mts-business-billing.service.js';
import { mtsBusinessCatalogService } from './mts-business-catalog.service.js';
import { mtsBusinessMetricsStoreService } from './mts-business-metrics-store.service.js';
import { mtsBusinessMappingService } from './mts-business-mapping.service.js';
import { mtsBusinessPersonalDataService } from './mts-business-personal-data.service.js';
import { MtsBusinessApiError, isFeatureUnavailable } from './mts-business-base.service.js';
import {
  tryAcquireSigurRuntimeLease,
  releaseSigurRuntimeLease,
  getSigurRuntimeOwner,
  getSigurRuntimeState,
  mergeSigurRuntimeState,
} from './sigur-runtime-state.service.js';
import { runWithCronMonitor, type CronRunStatus } from '../utils/sentry-cron.js';

// Ежедневный снимок баланса/неоплаченных счетов (по лицевым счетам) и
// баланса/начислений (по известным номерам) — история для тренд-графиков
// вкладки «Финансы». Паттерн — калька mts-business-cdr-daily-scheduler.service.ts:
// свой lease-ключ (чтобы не конкурировать с CDR-планировщиком за rate-gate
// одного аккаунта в одно окно), свой cron-monitor, тик раз в минуту + catchup.

const CHECK_INTERVAL_MS = 60_000;
const LEASE_KEY = 'mts_business_metrics_daily_sync';
const LEASE_TTL_SECONDS = 600;
const DAILY_STATE_KEY = 'mts_business_metrics_daily';

function resolveTargetHourMsk(): number {
  const parsed = Number.parseInt(env.MTS_BUSINESS_METRICS_DAILY_TARGET_HOUR_MSK, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 23) return 5;
  return parsed;
}

let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let lastRunYmdMsk: string | null = null;
let lastWeeklyRunYmdMsk: string | null = null;
let runInFlight: Promise<void> | null = null;

const daysBetween = (fromYmd: string, toYmd: string): number => {
  const a = new Date(`${fromYmd}T00:00:00Z`).getTime();
  const b = new Date(`${toYmd}T00:00:00Z`).getTime();
  return Math.round((b - a) / 86_400_000);
};

function getMoscowYmd(now: Date): string {
  const formatter = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = formatter.formatToParts(now);
  const get = (type: string): string => parts.find(p => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function getMoscowHour(now: Date): number {
  const formatter = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', hour12: false });
  const hourStr = formatter.formatToParts(now).find(p => p.type === 'hour')?.value ?? '0';
  return Number.parseInt(hourStr === '24' ? '0' : hourStr, 10);
}

const logSkip = (context: string, error: unknown): void => {
  if (isFeatureUnavailable(error)) {
    console.warn(`[mts-biz-metrics] ${context} — функция не подключена в тарифе МТС`);
    return;
  }
  if (error instanceof MtsBusinessApiError) {
    console.error(`[mts-biz-metrics] ${context} — ошибка http=${error.status} code=${error.code ?? '-'}`);
    return;
  }
  console.error(`[mts-biz-metrics] ${context} — ошибка:`, error instanceof Error ? error.message : 'unknown');
};

export interface IRefreshAccountResult {
  accountId: string;
  numbers: number;
  failed: number;      // не-1010 ошибки
  unavailable: number; // 403/1010 — функция не подключена в тарифе МТС
}

/**
 * Снимает баланс/кредитный лимит/неоплаченные счета по ЛС и баланс/начисления
 * по известным номерам аккаунта, апсертит в mts_business_metric_daily.
 * Используется и планировщиком (авто, раз в сутки), и ручным «Обновить
 * сейчас» из контроллера — одна функция, один источник правды для upsert.
 */
export async function refreshAccountMetrics(accountId: string): Promise<IRefreshAccountResult> {
  let failed = 0;
  let unavailable = 0;
  const bump = (error: unknown): void => {
    if (isFeatureUnavailable(error)) unavailable++;
    else failed++;
  };
  const accounts = await mtsBusinessAccountsService.list();
  const account = accounts.find(a => a.id === accountId);

  if (account?.accountNumber) {
    try {
      const balance = await mtsBusinessBillingService.checkBalanceByAccount(accountId, account.accountNumber);
      if (balance.amount != null) {
        await mtsBusinessMetricsStoreService.upsertDaily({
          accountId, scope: 'account', accountNo: account.accountNumber, metric: 'balance',
          amount: balance.amount, currencyCode: balance.currencyCode, validTo: balance.validUntil,
        });
      }
      if (balance.creditLimit != null) {
        await mtsBusinessMetricsStoreService.upsertDaily({
          accountId, scope: 'account', accountNo: account.accountNumber, metric: 'credit_limit',
          amount: balance.creditLimit,
        });
      }
    } catch (error) {
      bump(error);
      logSkip(`account="${account.label}" баланс ЛС`, error);
    }

    try {
      const unpaid = await mtsBusinessBillingService.getUnpaidAmountByAccounts(accountId, [account.accountNumber]);
      await mtsBusinessMetricsStoreService.upsertDaily({
        accountId, scope: 'account', accountNo: account.accountNumber, metric: 'unpaid_amount',
        amount: unpaid.amount, currencyCode: unpaid.currencyCode,
      });
    } catch (error) {
      bump(error);
      logSkip(`account="${account.label}" неоплаченные счета`, error);
    }
  }

  // Баланс по каждому номеру НЕ снимаем: у номера нет своего баланса — метод
  // возвращает общий баланс ЛС (уже снят выше). Экономия ~N вызовов на прогон.
  //
  // Начисления на номер (charges_amount) здесь тоже НЕ снимаем. Раньше брали
  // CheckCharges.remainedAmount — но это остаток по лицевому счёту, размноженный
  // по номерам (сотни тысяч ₽ на каждого, бессмысленная сумма-итог). Правильный
  // источник — сумма собственной выписки номера (syncMsisdnStatement →
  // sumStatementCharges), её пишет CDR-планировщик / «Обновить всё».
  const msisdns = await mtsBusinessMappingService.getAllKnownMsisdnsByAccount(accountId);

  return { accountId, numbers: msisdns.length, failed, unavailable };
}

export interface IRefreshHierarchyResult {
  accountId: string;
  totalNumbers: number; // номеров в структуре абонента
  discovered: number;   // из них заведено новых в number_map
  needsFio: string[];   // номера без сотрудника и без ФИО — кандидаты на PersonalDataInfo
  failed: number;
  unavailable: number;
}

/**
 * Структура абонента (HierarchyStructure) → снапшот + авто-обнаружение номеров
 * в mts_business_number_map. ФИО здесь НЕ добирается — это отдельный шаг
 * (refreshFioForNumbers), чтобы оркестратор «Обновить всё» показывал статусы
 * «номера» и «ФИО» раздельно (у них разные подписки в тарифе МТС).
 */
export async function refreshHierarchy(accountId: string): Promise<IRefreshHierarchyResult> {
  const result: IRefreshHierarchyResult = {
    accountId, totalNumbers: 0, discovered: 0, needsFio: [], failed: 0, unavailable: 0,
  };
  const accounts = await mtsBusinessAccountsService.list();
  const account = accounts.find(a => a.id === accountId);
  // Токен видит структуру ВСЕЙ организации (все ЛС сразу) — принадлежность
  // номера определяем по accountNo его customerAccount, а не по токену,
  // которым выгружали. Иначе номера «прилипают» к первому синкованному ЛС.
  const byAccountNo = new Map(
    accounts.filter(a => a.accountNumber).map(a => [a.accountNumber as string, a.id]),
  );

  try {
    const hierarchy = await mtsBusinessCatalogService.getHierarchyStructure(accountId);
    await mtsBusinessMetricsStoreService.upsertSnapshot({
      accountId, scope: 'account', accountNo: account?.accountNumber ?? null, metric: 'hierarchy', payload: hierarchy,
    });
    for (const n of hierarchy.numbers) {
      if (!n.msisdn) continue;
      result.totalNumbers++;
      const ownerAccountId = n.accountNo ? byAccountNo.get(n.accountNo) ?? null : null;
      const { needsFio, created } = await mtsBusinessMappingService.ensureNumberDiscovered(
        n.msisdn,
        ownerAccountId ?? accountId,
        ownerAccountId != null, // authoritative: настоящий ЛС известен из структуры
      );
      if (created) result.discovered++;
      // ФИО добираем ТОЛЬКО для действительно неизвестных номеров (нет ни
      // сотрудника, ни ФИО) — не дёргаем PersonalData/PersonalDataInfo повторно
      // для уже распознанных/подтверждённо-неоднозначных номеров.
      if (needsFio) result.needsFio.push(n.msisdn);
    }
  } catch (error) {
    if (isFeatureUnavailable(error)) result.unavailable++;
    else result.failed++;
    logSkip(`account=${accountId} структура абонента`, error);
  }
  return result;
}

export interface IRefreshFioResult {
  accountId: string;
  requested: number;
  fetched: number; // получено ФИО (персданные внесены на стороне МТС)
  failed: number;
  unavailable: number;
}

/** ФИО из PersonalData/PersonalDataInfo по списку номеров (+ кэш статуса подтверждения). */
export async function refreshFioForNumbers(accountId: string, msisdns: string[]): Promise<IRefreshFioResult> {
  const result: IRefreshFioResult = { accountId, requested: msisdns.length, fetched: 0, failed: 0, unavailable: 0 };
  for (const msisdn of msisdns) {
    try {
      const info = await mtsBusinessPersonalDataService.fetchAndCacheInfo(accountId, msisdn);
      if (info.fullName) {
        await mtsBusinessMappingService.syncMtsNames([{ msisdn, fio: info.fullName }], null);
        result.fetched++;
      }
    } catch (error) {
      if (isFeatureUnavailable(error)) result.unavailable++;
      else result.failed++;
      logSkip(`account=${accountId} номер — ФИО из PersonalData`, error);
    }
  }
  return result;
}

export interface IRefreshCatalogNumbersResult {
  accountId: string;
  numbers: number;
  failed: number;
  unavailable: number;
}

/** Остатки пакетов ЛС + тариф/услуги по всем известным номерам аккаунта. */
export async function refreshTariffAndServices(accountId: string): Promise<IRefreshCatalogNumbersResult> {
  let failed = 0;
  let unavailable = 0;
  const bump = (error: unknown): void => {
    if (isFeatureUnavailable(error)) unavailable++;
    else failed++;
  };
  const accounts = await mtsBusinessAccountsService.list();
  const account = accounts.find(a => a.id === accountId);

  if (account?.accountNumber) {
    try {
      const packages = await mtsBusinessBillingService.getValidityInfo(accountId, account.accountNumber);
      await mtsBusinessMetricsStoreService.upsertSnapshot({
        accountId, scope: 'account', accountNo: account.accountNumber, metric: 'validity_info', payload: packages,
      });
    } catch (error) {
      bump(error);
      logSkip(`account="${account.label}" остатки пакетов`, error);
    }
  }

  const msisdns = await mtsBusinessMappingService.getAllKnownMsisdnsByAccount(accountId);
  for (const msisdn of msisdns) {
    try {
      const tariff = await mtsBusinessCatalogService.getBillPlanInfo(accountId, msisdn);
      await mtsBusinessMetricsStoreService.upsertSnapshot({ accountId, scope: 'msisdn', msisdn, metric: 'bill_plan', payload: tariff });
    } catch (error) {
      bump(error);
      logSkip(`account=${accountId} номер — тариф`, error);
    }
    try {
      const services = await mtsBusinessCatalogService.getProductInfo(accountId, msisdn);
      await mtsBusinessMetricsStoreService.upsertSnapshot({ accountId, scope: 'msisdn', msisdn, metric: 'product_services', payload: services });
    } catch (error) {
      bump(error);
      logSkip(`account=${accountId} номер — услуги`, error);
    }
  }

  return { accountId, numbers: msisdns.length, failed, unavailable };
}

export interface IRefreshCatalogResult {
  accountId: string;
  numbers: number;
  discovered: number;
  failed: number;
  unavailable: number;
}

/**
 * Полное обновление каталога: структура абонента + ФИО новых номеров + пакеты/
 * тариф/услуги. Композиция трёх шагов — используется еженедельным кадансом
 * планировщика и ручным «Обновить каталог»; оркестратор «Обновить всё» вызывает
 * шаги по отдельности (раздельные статусы).
 */
export async function refreshAccountCatalog(accountId: string): Promise<IRefreshCatalogResult> {
  const hier = await refreshHierarchy(accountId);
  const fio = await refreshFioForNumbers(accountId, hier.needsFio);
  const cat = await refreshTariffAndServices(accountId);
  return {
    accountId,
    numbers: cat.numbers,
    discovered: hier.discovered,
    failed: hier.failed + fio.failed + cat.failed,
    unavailable: hier.unavailable + fio.unavailable + cat.unavailable,
  };
}

async function runDailySyncCycle(ymd: string): Promise<void> {
  if (runInFlight) return;

  runInFlight = (async () => {
    const startedAtIso = new Date().toISOString();
    let cronStatus: CronRunStatus = 'ok';
    const owner = getSigurRuntimeOwner(LEASE_KEY);

    const acq = await tryAcquireSigurRuntimeLease({ key: LEASE_KEY, owner, ttlSeconds: LEASE_TTL_SECONDS });
    if (!acq.acquired) {
      runInFlight = null;
      return;
    }

    try {
      await runWithCronMonitor(
        'mts-business-metrics-daily',
        async () => {
          try {
            const accounts = (await mtsBusinessAccountsService.list()).filter(a => a.isActive);
            console.log(`[mts-biz-metrics] старт accounts=${accounts.length}`);

            let totalNumbers = 0;
            let totalFailed = 0;
            for (const account of accounts) {
              const res = await refreshAccountMetrics(account.id);
              totalNumbers += res.numbers;
              totalFailed += res.failed;
              console.log(`[mts-biz-metrics] account="${account.label}" numbers=${res.numbers} failed=${res.failed}`);
            }

            // Каталог (тариф/услуги/пакеты/структура) — реже, раз в 7 суток:
            // меняется редко, не стоит гонять по rate-gate каждый день.
            const dueWeekly = !lastWeeklyRunYmdMsk || daysBetween(lastWeeklyRunYmdMsk, ymd) >= 7;
            let totalCatalogNumbers = 0;
            let totalDiscovered = 0;
            let totalCatalogFailed = 0;
            if (dueWeekly) {
              for (const account of accounts) {
                const res = await refreshAccountCatalog(account.id);
                totalCatalogNumbers += res.numbers;
                totalDiscovered += res.discovered;
                totalCatalogFailed += res.failed;
                console.log(`[mts-biz-metrics] catalog account="${account.label}" numbers=${res.numbers} discovered=${res.discovered} failed=${res.failed}`);
              }
              lastWeeklyRunYmdMsk = ymd;
            }

            lastRunYmdMsk = ymd;
            await mergeSigurRuntimeState({
              key: DAILY_STATE_KEY,
              meta: {
                lastRunYmdMsk: ymd,
                lastWeeklyRunYmdMsk,
                lastSuccessAt: new Date().toISOString(),
                lastStartedAt: startedAtIso,
                // lastError чистим: старый сбой не должен всплывать рядом со свежим успехом.
                lastError: null,
                lastResult: { accounts: accounts.length, numbers: totalNumbers, failed: totalFailed },
                ...(dueWeekly ? { lastCatalogResult: { accounts: accounts.length, numbers: totalCatalogNumbers, discovered: totalDiscovered, failed: totalCatalogFailed } } : {}),
              },
            }).catch(err => console.error('[mts-biz-metrics] mergeSigurRuntimeState error:', (err as Error).message));
          } catch (error) {
            cronStatus = 'error';
            lastRunYmdMsk = null;
            console.error('[mts-biz-metrics] error:', error instanceof Error ? error.message : 'unknown');
            Sentry.captureException(error);
            await mergeSigurRuntimeState({
              key: DAILY_STATE_KEY,
              meta: { lastFailureAt: new Date().toISOString(), lastError: error instanceof Error ? error.message : 'unknown' },
            }).catch(err => console.error('[mts-biz-metrics] mergeSigurRuntimeState failure error:', (err as Error).message));
          }
          return cronStatus;
        },
        {
          schedule: { type: 'crontab', value: `0 ${resolveTargetHourMsk()} * * *` },
          checkinMargin: 15,
          maxRuntime: 30,
        },
      );
    } finally {
      await releaseSigurRuntimeLease({ key: LEASE_KEY, owner }).catch(err =>
        console.error('[mts-biz-metrics] release lease failed:', (err as Error).message),
      );
      runInFlight = null;
    }
  })();

  return runInFlight;
}

function onTick(): void {
  const targetHour = resolveTargetHourMsk();
  const now = new Date();
  const ymd = getMoscowYmd(now);
  const hour = getMoscowHour(now);
  if (hour < targetHour) return;
  if (lastRunYmdMsk === ymd) return;
  void runDailySyncCycle(ymd);
}

async function loadLastRunFromRuntimeState(): Promise<void> {
  try {
    const state = await getSigurRuntimeState(DAILY_STATE_KEY);
    const stored = state?.meta?.lastRunYmdMsk;
    if (typeof stored === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(stored)) {
      lastRunYmdMsk = stored;
    }
    const storedWeekly = state?.meta?.lastWeeklyRunYmdMsk;
    if (typeof storedWeekly === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(storedWeekly)) {
      lastWeeklyRunYmdMsk = storedWeekly;
    }
  } catch (err) {
    console.error('[mts-biz-metrics] failed to load runtime_state:', (err as Error).message);
  }
}

export async function startMtsBusinessMetricsDailyScheduler(): Promise<void> {
  if (schedulerTimer) return;
  await loadLastRunFromRuntimeState();
  const targetHour = resolveTargetHourMsk();
  console.log(`[mts-biz-metrics] started (daily ≥${String(targetHour).padStart(2, '0')}:00 MSK with catchup)`);
  schedulerTimer = setInterval(onTick, CHECK_INTERVAL_MS);
  onTick();
}

export function stopMtsBusinessMetricsDailyScheduler(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
    console.log('[mts-biz-metrics] stopped');
  }
}
