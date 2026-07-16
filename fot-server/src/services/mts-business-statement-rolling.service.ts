import * as Sentry from '@sentry/node';
import { mtsBusinessAccountsService } from './mts-business-accounts.service.js';
import { mtsBusinessMappingService } from './mts-business-mapping.service.js';
import { settingsService, type IMtsBusinessRollingSettings } from './settings.service.js';
import { syncMsisdnStatement } from './mts-business-statement-sync.service.js';
import { refreshCdrRollup } from './mts-business-cdr.service.js';
import {
  isFeatureUnavailable,
  isTransientMtsError,
  mtsErrorBucket,
  mtsPermanentErrorKind,
  mtsPerSecondLimit,
} from './mts-business-base.service.js';
import {
  tryAcquireSigurRuntimeLease,
  releaseSigurRuntimeLease,
  startSigurRuntimeLeaseHeartbeat,
  getSigurRuntimeOwner,
  getSigurRuntimeState,
  mergeSigurRuntimeState,
} from './sigur-runtime-state.service.js';
import { mtsBusinessSyncLogService, mtsErrorCodeOf } from './mts-business-sync-log.service.js';

// Непрерывный конвейер свежести выписки МТС Бизнес.
//
// Зачем: МТС отдаёт звонок в выписке уже через ~6–12 минут после его окончания,
// но раньше выписка тянулась только ночью → данные в модуле отставали на часы.
// Один запрос Bills/BillingStatementExtdByMSISDN по номеру приносит сразу
// звонки (mts_business_cdr), начисления по дням (metric_daily) и строки выписки
// (statement_rows — вкладка «Использование» и ЛК «Моя SIM»).
//
// Как: воркер крутится всегда и берёт номера «кого дольше всех не обновляли»
// (см. getStatementQueue, миграция 220), тратя не весь лимит аккаунта, а его
// долю (budgetSharePercent) — остаток остаётся живым вызовам UI. Лимит МТС —
// на Consumer Key, поэтому аккаунты (лицевые счета) обрабатываются параллельно.
//
// Профили (тариф/услуги/ПДн, ~5 запросов на номер) в конвейер НЕ входят: они
// меняются редко и съели бы весь бюджет — остаются за ночным «Обновить всё».

const LEASE_KEY = 'mts_business_statement_rolling';
const LEASE_TTL_SECONDS = 120;
const TICK_MS = 30_000;

/** Номер считается «горячим», если событие в выписке было за последние N дней. */
const ACTIVE_DAYS = 7;

/** Роллап CDR — дорогой REFRESH MATERIALIZED VIEW: не чаще раза в 5 минут. */
const ROLLUP_MIN_INTERVAL_MS = 5 * 60_000;

/** Окно выписки: сегодня и вчера (МСК) — свежие события + поздние корректировки. */
const WINDOW_DAYS_BACK = 1;

/** DRY-RUN: строим очередь и логируем, но не ходим в МТС и не пишем в БД. */
const isDryRun = (): boolean => process.env.MTS_ROLLING_DRY_RUN === '1';

export interface IRollingAccountStat {
  accountId: string;
  accountLabel: string;
  /** Сколько номеров ждут обновления прямо сейчас (глубина очереди). */
  pending: number;
  synced: number;
  failed: number;
  noAccess: number;
  unavailable: number;
  transient: number;
  errorBreakdown: Record<string, number>;
}

export interface IRollingStatus {
  enabled: boolean;
  running: boolean;
  dryRun: boolean;
  settings: IMtsBusinessRollingSettings | null;
  lastTickAt: string | null;
  /** Свежесть выписки: сколько номеров обновлено за последний час работы. */
  syncedLastHour: number;
  accounts: IRollingAccountStat[];
}

let timer: ReturnType<typeof setInterval> | null = null;
let tickInFlight = false;
let lastRollupAt = 0;
let syncedSinceHourStart = 0;
let hourStartedAt = Date.now();

const moscowYmd = (now: Date): string => {
  const parts = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const get = (type: string): string => parts.find(p => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
};

const addDays = (ymd: string, days: number): string => {
  const [y, m, d] = ymd.split('-').map(n => Number.parseInt(n, 10));
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

/**
 * Бюджет тика для аккаунта: сколько запросов можно потратить за TICK_MS, не
 * выходя за долю лимита. Дополнительно ограничиваем секундным суб-лимитом МТС
 * (3 или 10 запросов/сек) — гейт в base-сервисе всё равно не даст больше, но
 * без этого пачка была бы неоправданно длинной.
 */
export const tickBudget = (rateLimitPerMin: number, sharePercent: number, tickMs: number): number => {
  const perMinute = Math.floor((rateLimitPerMin * sharePercent) / 100);
  const perTick = Math.floor((perMinute * tickMs) / 60_000);
  const secondsInTick = Math.ceil(tickMs / 1000);
  return Math.max(1, Math.min(perTick, mtsPerSecondLimit(rateLimitPerMin) * secondsInTick));
};

interface IAccountRun {
  id: string;
  label: string;
  rateLimitPerMin: number;
}

/** Один проход по очереди аккаунта в пределах бюджета тика. */
async function runAccountBatch(
  account: IAccountRun,
  settings: IMtsBusinessRollingSettings,
  window: { dateFrom: string; dateTo: string },
): Promise<IRollingAccountStat> {
  const stat: IRollingAccountStat = {
    accountId: account.id,
    accountLabel: account.label,
    pending: 0,
    synced: 0,
    failed: 0,
    noAccess: 0,
    unavailable: 0,
    transient: 0,
    errorBreakdown: {},
  };

  const budget = tickBudget(account.rateLimitPerMin, settings.budgetSharePercent, TICK_MS);
  const queue = await mtsBusinessMappingService.getStatementQueue({
    accountId: account.id,
    hotMinutes: settings.hotMinutes,
    coldHours: settings.coldHours,
    activeDays: ACTIVE_DAYS,
    limit: budget,
  });
  stat.pending = queue.length;

  if (isDryRun()) {
    console.log(`[mts-biz-rolling] DRY-RUN account="${account.label}" бюджет=${budget} очередь=${queue.length}`);
    return stat;
  }

  for (const item of queue) {
    try {
      const res = await syncMsisdnStatement(
        account.id,
        item.msisdn,
        window.dateFrom,
        window.dateTo,
        null,
        'rolling',
        false, // узкое окно: не расширять до 1-го числа месяца
      );
      // Окно синка — вчера/сегодня: если в нём есть строки, номер активен ПРЯМО
      // сейчас → last_usage_at = now (критерий «горячего»). Пустое окно оставляет
      // прежнее значение (GREATEST игнорирует NULL), и номер постепенно остывает.
      const lastUsageAt = res.usageRowsParsed > 0 ? new Date() : null;
      await mtsBusinessMappingService.markStatementSynced({
        msisdnHash: item.msisdnHash, ok: true, lastUsageAt,
      });
      stat.synced++;
      syncedSinceHourStart++;
    } catch (error) {
      // Свойства номера (не сбой прогона): помечаем синк выполненным, чтобы
      // номер ушёл в конец очереди и не блокировал остальных.
      const permanent = mtsPermanentErrorKind(error);
      if (isFeatureUnavailable(error)) stat.unavailable++;
      else if (permanent === 'no_access') stat.noAccess++;
      else if (isTransientMtsError(error)) stat.transient++;
      else stat.failed++;
      // Всё, кроме транзиентов, — в «Лог синхронизации» standalone-записью
      // (у конвейера нет прогонов; объём ограничен tickBudget). Транзиент
      // 421/3003 не пишем: номер повторится следующим тиком — иначе одна и та же
      // ошибка дублировалась бы каждые 30 секунд, пока МТС не оживёт.
      if (!isTransientMtsError(error)) {
        await mtsBusinessSyncLogService.logStandalone('rolling', {
          level: permanent === 'no_access' || isFeatureUnavailable(error) ? 'warn' : 'error',
          step: 'statement',
          accountId: account.id,
          msisdn: item.msisdn,
          errorCode: mtsErrorCodeOf(error),
          bucket: mtsErrorBucket(error),
          message: isFeatureUnavailable(error)
            ? `${account.label}: выписка не подключена в тарифе МТС`
            : permanent === 'no_access'
              ? `${account.label}: номер вне доступа портального пользователя`
              : `${account.label}: ошибка синка выписки номера`,
        });
      }

      const bucket = mtsErrorBucket(error);
      stat.errorBreakdown[bucket] = (stat.errorBreakdown[bucket] ?? 0) + 1;

      // Транзиент (421/3003, 5xx) — НЕ трогаем statement_synced_at: номер
      // повторится следующим тиком. Остальное — считаем попыткой.
      if (!isTransientMtsError(error)) {
        await mtsBusinessMappingService.markStatementSynced({
          msisdnHash: item.msisdnHash, ok: false, lastUsageAt: null,
        }).catch(() => undefined);
      }
    }
  }

  if (stat.synced > 0 || stat.failed > 0) {
    console.log(
      `[mts-biz-rolling] account="${account.label}" бюджет=${budget} очередь=${queue.length} `
      + `обновлено=${stat.synced} ошибок=${stat.failed} нет_доступа=${stat.noAccess} транзиент=${stat.transient}`,
    );
  }
  return stat;
}

async function onTick(): Promise<void> {
  if (tickInFlight) return;
  tickInFlight = true;

  const owner = getSigurRuntimeOwner(LEASE_KEY);
  let stopHeartbeat: (() => void) | null = null;
  try {
    const settings = await settingsService.getMtsBusinessRolling();
    if (!settings.enabled) return;

    // Не конкурируем за лимит с ночным «Обновить всё»: он тяжелее и важнее
    // (профили/иерархия), конвейер подождёт — его номера всё равно освежит
    // шаг детализации внутри прогона.
    const refreshAll = await getSigurRuntimeState('mts_business_refresh_all');
    const refreshAllAlive = refreshAll?.lease_expires_at != null
      && Date.parse(refreshAll.lease_expires_at) > Date.now();
    if (refreshAllAlive) return;

    const acq = await tryAcquireSigurRuntimeLease({ key: LEASE_KEY, owner, ttlSeconds: LEASE_TTL_SECONDS });
    if (!acq.acquired) return; // конвейер уже крутится на другом инстансе

    stopHeartbeat = startSigurRuntimeLeaseHeartbeat({
      key: LEASE_KEY,
      owner,
      ttlSeconds: LEASE_TTL_SECONDS,
      onError: err => console.error('[mts-biz-rolling] heartbeat failed:', err.message),
    });

    const accounts = (await mtsBusinessAccountsService.list())
      .filter(a => a.isActive)
      .map(a => ({ id: a.id, label: a.label, rateLimitPerMin: a.rateLimitPerMin }));
    if (accounts.length === 0) return;

    const today = moscowYmd(new Date());
    const window = { dateFrom: addDays(today, -WINDOW_DAYS_BACK), dateTo: today };

    // Аккаунты параллельно: rate-limit МТС считается на Consumer Key аккаунта.
    const stats = await Promise.all(accounts.map(a => runAccountBatch(a, settings, window)));

    const synced = stats.reduce((sum, s) => sum + s.synced, 0);
    if (synced > 0 && Date.now() - lastRollupAt > ROLLUP_MIN_INTERVAL_MS) {
      await refreshCdrRollup();
      lastRollupAt = Date.now();
    }

    if (Date.now() - hourStartedAt > 3_600_000) {
      hourStartedAt = Date.now();
      syncedSinceHourStart = synced;
    }

    await mergeSigurRuntimeState({
      key: LEASE_KEY,
      meta: {
        lastTickAt: new Date().toISOString(),
        syncedLastHour: syncedSinceHourStart,
        accounts: stats,
      },
    }).catch(err => console.error('[mts-biz-rolling] persist state failed:', (err as Error).message));
  } catch (error) {
    console.error('[mts-biz-rolling] тик упал:', error instanceof Error ? error.message : 'unknown');
    Sentry.captureException(error, { tags: { module: 'mts-business', kind: 'statement-rolling' } });
  } finally {
    if (stopHeartbeat) stopHeartbeat();
    await releaseSigurRuntimeLease({ key: LEASE_KEY, owner }).catch(() => undefined);
    tickInFlight = false;
  }
}

/** Текущее состояние конвейера для админки (панель «Непрерывное обновление»). */
export async function getRollingStatus(): Promise<IRollingStatus> {
  const settings = await settingsService.getMtsBusinessRolling();
  const state = await getSigurRuntimeState(LEASE_KEY);
  const meta = (state?.meta ?? {}) as {
    lastTickAt?: string;
    syncedLastHour?: number;
    accounts?: IRollingAccountStat[];
  };
  return {
    enabled: settings.enabled,
    running: tickInFlight,
    dryRun: isDryRun(),
    settings,
    lastTickAt: meta.lastTickAt ?? null,
    syncedLastHour: meta.syncedLastHour ?? 0,
    accounts: Array.isArray(meta.accounts) ? meta.accounts : [],
  };
}

export function startMtsBusinessStatementRollingWorker(): void {
  if (timer) return;
  console.log(`[mts-biz-rolling] started (тик ${TICK_MS / 1000}с${isDryRun() ? ', DRY-RUN' : ''})`);
  timer = setInterval(() => { void onTick(); }, TICK_MS);
  void onTick();
}

export function stopMtsBusinessStatementRollingWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    console.log('[mts-biz-rolling] stopped');
  }
}
