import * as Sentry from '@sentry/node';
import { env } from '../config/env.js';
import { mtsBusinessAccountsService } from './mts-business-accounts.service.js';
import { mtsBusinessDataService } from './mts-business-data.service.js';
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

// Ежедневное автообновление детализации звонков через синхронный
// Bills/BillingStatementExtdByMSISDN (без email/IMAP) — по одному номеру на
// запрос, через общий rate-limit гейт per accountId (mts-business-base.service).
// Известные номера аккаунта — объединение CDR-истории и инвентаря number_map
// (HierarchyStructure): новый номер, найденный синком структуры, подхватывается
// автоматически, без ручного бэкафилла.
//
// Тик раз в минуту, работа выполняется один раз в сутки при первом тике после
// TARGET_HOUR MSK (catchup при рестарте сервера — как sigur-events-daily).

const CHECK_INTERVAL_MS = 60_000;
const LEASE_KEY = 'mts_business_cdr_daily_sync';
const LEASE_TTL_SECONDS = 600;
const DAILY_STATE_KEY = 'mts_business_cdr_daily';

function resolveTargetHourMsk(): number {
  const parsed = Number.parseInt(env.MTS_BUSINESS_CDR_DAILY_TARGET_HOUR_MSK, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 23) return 4;
  return parsed;
}

function resolveWindowDays(): number {
  const parsed = Number.parseInt(env.MTS_BUSINESS_CDR_DAILY_WINDOW_DAYS, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 3;
  return parsed;
}

let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let lastRunYmdMsk: string | null = null;
let runInFlight: Promise<void> | null = null;

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

function addDaysYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(n => Number.parseInt(n, 10));
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  const yy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

async function syncAccount(accountId: string, dateFrom: string, dateTo: string): Promise<{ numbers: number; inserted: number; failed: number; unavailable: number }> {
  const msisdns = await mtsBusinessMappingService.getAllKnownMsisdnsByAccount(accountId);
  let inserted = 0;
  let failed = 0;
  let unavailable = 0;
  const allCalls: Parameters<typeof mtsBusinessCdrService.storeCalls>[0] = [];

  for (const msisdn of msisdns) {
    try {
      const resp = await mtsBusinessDataService.getBillingStatementExtdByMsisdn(accountId, { msisdn, dateFrom, dateTo });
      const calls = mtsBusinessCdrService.parseBillingStatementResponse(resp, msisdn);
      allCalls.push(...calls);
    } catch (error) {
      if (isFeatureUnavailable(error)) {
        unavailable++;
      } else {
        failed++;
      }
      if (error instanceof MtsBusinessApiError) {
        console.error(`[mts-biz-cdr-daily] account=${accountId} номер — ошибка http=${error.status} code=${error.code ?? '-'}`);
      } else {
        console.error(`[mts-biz-cdr-daily] account=${accountId} номер — ошибка:`, error instanceof Error ? error.message : 'unknown');
      }
    }
  }

  if (allCalls.length > 0) {
    const result = await mtsBusinessCdrService.storeCalls(allCalls, null, accountId);
    inserted = result.inserted;
  }
  return { numbers: msisdns.length, inserted, failed, unavailable };
}

async function runDailySyncCycle(ymd: string): Promise<void> {
  if (runInFlight) return;

  runInFlight = (async () => {
    const startedAtIso = new Date().toISOString();
    const windowDays = resolveWindowDays();
    // Синхронизируем вчера ± catchup-окно (без сегодняшнего дня — он ещё не
    // полностью тарифицирован МТС на момент утреннего тика).
    const dateTo = addDaysYmd(ymd, -1);
    const dateFrom = addDaysYmd(ymd, -windowDays);
    let cronStatus: CronRunStatus = 'ok';
    const owner = getSigurRuntimeOwner(LEASE_KEY);

    const acq = await tryAcquireSigurRuntimeLease({ key: LEASE_KEY, owner, ttlSeconds: LEASE_TTL_SECONDS });
    if (!acq.acquired) {
      runInFlight = null;
      return;
    }

    try {
      await runWithCronMonitor(
        'mts-business-cdr-daily',
        async () => {
          try {
            const accounts = (await mtsBusinessAccountsService.list()).filter(a => a.isActive);
            console.log(`[mts-biz-cdr-daily] старт range=${dateFrom}..${dateTo} accounts=${accounts.length}`);

            let totalNumbers = 0;
            let totalInserted = 0;
            let totalFailed = 0;
            let totalUnavailable = 0;
            for (const account of accounts) {
              const res = await syncAccount(account.id, dateFrom, dateTo);
              totalNumbers += res.numbers;
              totalInserted += res.inserted;
              totalFailed += res.failed;
              totalUnavailable += res.unavailable;
              console.log(`[mts-biz-cdr-daily] account="${account.label}" numbers=${res.numbers} inserted=${res.inserted} failed=${res.failed} unavailable=${res.unavailable}`);
            }

            lastRunYmdMsk = ymd;
            await mergeSigurRuntimeState({
              key: DAILY_STATE_KEY,
              meta: {
                lastRunYmdMsk: ymd,
                lastSuccessAt: new Date().toISOString(),
                lastStartedAt: startedAtIso,
                lastWindow: { dateFrom, dateTo },
                lastResult: { accounts: accounts.length, numbers: totalNumbers, inserted: totalInserted, failed: totalFailed, unavailable: totalUnavailable },
              },
            }).catch(err => console.error('[mts-biz-cdr-daily] mergeSigurRuntimeState error:', (err as Error).message));
          } catch (error) {
            cronStatus = 'error';
            lastRunYmdMsk = null;
            console.error('[mts-biz-cdr-daily] error:', error instanceof Error ? error.message : 'unknown');
            Sentry.captureException(error);
            await mergeSigurRuntimeState({
              key: DAILY_STATE_KEY,
              meta: { lastFailureAt: new Date().toISOString(), lastError: error instanceof Error ? error.message : 'unknown' },
            }).catch(err => console.error('[mts-biz-cdr-daily] mergeSigurRuntimeState failure error:', (err as Error).message));
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
        console.error('[mts-biz-cdr-daily] release lease failed:', (err as Error).message),
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
  } catch (err) {
    console.error('[mts-biz-cdr-daily] failed to load runtime_state:', (err as Error).message);
  }
}

export async function startMtsBusinessCdrDailyScheduler(): Promise<void> {
  if (schedulerTimer) return;
  await loadLastRunFromRuntimeState();
  const targetHour = resolveTargetHourMsk();
  console.log(`[mts-biz-cdr-daily] started (daily ≥${String(targetHour).padStart(2, '0')}:00 MSK with catchup, windowDays=${resolveWindowDays()})`);
  schedulerTimer = setInterval(onTick, CHECK_INTERVAL_MS);
  onTick();
}

export function stopMtsBusinessCdrDailyScheduler(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
    console.log('[mts-biz-cdr-daily] stopped');
  }
}
