import * as Sentry from '@sentry/node';
import { env } from '../config/env.js';
import { mtsBusinessAccountsService } from './mts-business-accounts.service.js';
import { mtsBusinessBillingService } from './mts-business-billing.service.js';
import { mtsBusinessCatalogService } from './mts-business-catalog.service.js';
import { mtsBusinessMetricsStoreService } from './mts-business-metrics-store.service.js';
import { mtsBusinessCdrService } from './mts-business-cdr.service.js';
import { mtsBusinessMappingService } from './mts-business-mapping.service.js';
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

/**
 * Известные номера аккаунта — объединение CDR-истории и number_map (номера,
 * найденные через HierarchyStructure, в CDR могут вообще не встречаться).
 * Без объединения синк баланса/тарифа не видел бы номера, обнаруженные
 * только через структуру абонента, даже после привязки к сотруднику.
 */
async function getAllKnownMsisdns(accountId: string): Promise<string[]> {
  const [cdrNumbers, mappedNumbers] = await Promise.all([
    mtsBusinessCdrService.getKnownMsisdnsByAccount(accountId),
    mtsBusinessMappingService.getKnownMsisdnsByAccount(accountId),
  ]);
  return [...new Set([...cdrNumbers, ...mappedNumbers])];
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
  failed: number;
}

/**
 * Снимает баланс/кредитный лимит/неоплаченные счета по ЛС и баланс/начисления
 * по известным номерам аккаунта, апсертит в mts_business_metric_daily.
 * Используется и планировщиком (авто, раз в сутки), и ручным «Обновить
 * сейчас» из контроллера — одна функция, один источник правды для upsert.
 */
export async function refreshAccountMetrics(accountId: string): Promise<IRefreshAccountResult> {
  let failed = 0;
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
      failed++;
      logSkip(`account="${account.label}" баланс ЛС`, error);
    }

    try {
      const unpaid = await mtsBusinessBillingService.getUnpaidAmountByAccounts(accountId, [account.accountNumber]);
      await mtsBusinessMetricsStoreService.upsertDaily({
        accountId, scope: 'account', accountNo: account.accountNumber, metric: 'unpaid_amount',
        amount: unpaid.amount, currencyCode: unpaid.currencyCode,
      });
    } catch (error) {
      failed++;
      logSkip(`account="${account.label}" неоплаченные счета`, error);
    }
  }

  const msisdns = await getAllKnownMsisdns(accountId);
  for (const msisdn of msisdns) {
    try {
      const balance = await mtsBusinessBillingService.checkBalanceByMsisdn(accountId, msisdn);
      if (balance.amount != null) {
        await mtsBusinessMetricsStoreService.upsertDaily({
          accountId, scope: 'msisdn', msisdn, metric: 'balance',
          amount: balance.amount, currencyCode: balance.currencyCode, validTo: balance.validUntil,
        });
      }
    } catch (error) {
      failed++;
      logSkip(`account=${accountId} номер — баланс`, error);
    }
  }

  if (msisdns.length > 0) {
    try {
      const charges = await mtsBusinessBillingService.checkChargesBulk(accountId, msisdns);
      for (const c of charges) {
        if (c.amount == null) continue;
        await mtsBusinessMetricsStoreService.upsertDaily({
          accountId, scope: 'msisdn', msisdn: c.msisdn, metric: 'charges_amount',
          amount: c.amount, validFrom: c.periodStart, validTo: c.periodEnd,
        });
      }
    } catch (error) {
      failed++;
      logSkip(`account=${accountId} начисления (bulk)`, error);
    }
  }

  return { accountId, numbers: msisdns.length, failed };
}

export interface IRefreshCatalogResult {
  accountId: string;
  numbers: number;
  discovered: number;
  failed: number;
}

/**
 * Снимает остатки пакетов ЛС, структуру абонента (+авто-обнаружение новых
 * номеров в mts_business_number_map) и тариф/услуги по известным номерам —
 * реже, чем баланс/начисления (меняется редко). Используется еженедельным
 * кадансом планировщика и ручным «Обновить сейчас».
 */
export async function refreshAccountCatalog(accountId: string): Promise<IRefreshCatalogResult> {
  let failed = 0;
  let discovered = 0;
  const accounts = await mtsBusinessAccountsService.list();
  const account = accounts.find(a => a.id === accountId);

  if (account?.accountNumber) {
    try {
      const packages = await mtsBusinessBillingService.getValidityInfo(accountId, account.accountNumber);
      await mtsBusinessMetricsStoreService.upsertSnapshot({
        accountId, scope: 'account', accountNo: account.accountNumber, metric: 'validity_info', payload: packages,
      });
    } catch (error) {
      failed++;
      logSkip(`account="${account.label}" остатки пакетов`, error);
    }
  }

  try {
    const hierarchy = await mtsBusinessCatalogService.getHierarchyStructure(accountId);
    await mtsBusinessMetricsStoreService.upsertSnapshot({
      accountId, scope: 'account', accountNo: account?.accountNumber ?? null, metric: 'hierarchy', payload: hierarchy,
    });
    for (const n of hierarchy.numbers) {
      if (!n.msisdn) continue;
      const { needsFio } = await mtsBusinessMappingService.ensureNumberDiscovered(n.msisdn, accountId);
      discovered++;
      // ФИО добираем ТОЛЬКО для действительно неизвестных номеров (нет ни
      // сотрудника, ни ФИО) — не дёргаем PersonalData/PersonalDataInfo повторно
      // для уже распознанных/подтверждённо-неоднозначных номеров.
      if (needsFio) {
        try {
          const fio = await mtsBusinessCatalogService.getPersonalDataFio(accountId, n.msisdn);
          if (fio) await mtsBusinessMappingService.syncMtsNames([{ msisdn: n.msisdn, fio }], null);
        } catch (error) {
          logSkip(`account=${accountId} номер — ФИО из PersonalData`, error);
        }
      }
    }
  } catch (error) {
    failed++;
    logSkip(`account=${accountId} структура абонента`, error);
  }

  const msisdns = await getAllKnownMsisdns(accountId);
  for (const msisdn of msisdns) {
    try {
      const tariff = await mtsBusinessCatalogService.getBillPlanInfo(accountId, msisdn);
      await mtsBusinessMetricsStoreService.upsertSnapshot({ accountId, scope: 'msisdn', msisdn, metric: 'bill_plan', payload: tariff });
    } catch (error) {
      failed++;
      logSkip(`account=${accountId} номер — тариф`, error);
    }
    try {
      const services = await mtsBusinessCatalogService.getProductInfo(accountId, msisdn);
      await mtsBusinessMetricsStoreService.upsertSnapshot({ accountId, scope: 'msisdn', msisdn, metric: 'product_services', payload: services });
    } catch (error) {
      failed++;
      logSkip(`account=${accountId} номер — услуги`, error);
    }
  }

  return { accountId, numbers: msisdns.length, discovered, failed };
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
