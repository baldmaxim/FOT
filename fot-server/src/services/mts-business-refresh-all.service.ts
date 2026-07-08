import { hostname } from 'node:os';
import * as Sentry from '@sentry/node';
import { mtsBusinessAccountsService } from './mts-business-accounts.service.js';
import { mtsBusinessCatalogService } from './mts-business-catalog.service.js';
import { mtsBusinessMappingService } from './mts-business-mapping.service.js';
import { isFeatureUnavailable, formatMtsErrorBreakdown } from './mts-business-base.service.js';
import {
  refreshHierarchy,
  refreshFioForNumbers,
  refreshTariffAndServices,
  refreshAccountMetrics,
} from './mts-business-metrics-daily-scheduler.service.js';
import { syncAccountSubscribers } from './mts-business-subscriber-sync.service.js';
import { syncMsisdnsBatch } from './mts-business-statement-sync.service.js';
import {
  tryAcquireSigurRuntimeLease,
  releaseSigurRuntimeLease,
  startSigurRuntimeLeaseHeartbeat,
  getSigurRuntimeOwner,
  getSigurRuntimeState,
  mergeSigurRuntimeState,
} from './sigur-runtime-state.service.js';

// Оркестратор «Обновить всё» (кнопка на основной странице МТС Бизнес): один
// фоновый прогон обновляет ВСЁ, что умеет API — инвентарь номеров
// (HierarchyStructure), ФИО (PersonalDataInfo), комментарии из ЛК
// (GetCommentsByMSISDN), балансы/начисления, детализацию звонков
// (BillingStatementExtdByMSISDN, по умолчанию с начала текущего месяца) и
// тарифы/услуги/пакеты. Прогон на десятки номеров при лимите 60 зап/мин
// занимает минуты → работа в фоне, прогресс по шагам persist'ится в
// sigur_runtime_state.meta после каждого шага (переживает рестарт tsx watch и
// виден любому инстансу PM2). Конкурентность — lease с heartbeat (тот же
// паттерн, что у ночных планировщиков; свой ключ, чтобы не конкурировать).
//
// Статус шага 'unavailable' (МТС 403/errorCode 1010 — продукт не подключён в
// тарифе на этом ЛС) показывается в UI отдельно от реальных ошибок: это
// решается подключением продукта у менеджера МТС, а не кодом.

const LEASE_KEY = 'mts_business_refresh_all';
const LEASE_TTL_SECONDS = 600;

export type RefreshAllStepId = 'hierarchy' | 'fio' | 'comments' | 'billing' | 'detalization' | 'catalog' | 'subscribers';
export type RefreshAllStepStatus = 'pending' | 'running' | 'ok' | 'unavailable' | 'error';

export const REFRESH_ALL_STEP_LABELS: Record<RefreshAllStepId, string> = {
  hierarchy: 'Номера (структура абонента)',
  fio: 'ФИО (персональные данные)',
  comments: 'Комментарии из ЛК МТС',
  billing: 'Балансы и начисления',
  detalization: 'Детализация звонков',
  catalog: 'Тарифы, услуги и пакеты',
  subscribers: 'Профили: ФИО, тарифы, услуги',
};

// Бюджет вызовов критичен (rate-limit 60/300 в мин на аккаунт, номеров ~1500):
// шаги 'fio' и 'catalog' ИСКЛЮЧЕНЫ из прогона — их полностью покрывает шаг
// 'subscribers' (PersonalDataInfo + тариф/абонплата/услуги/блокировки на номер),
// иначе те же вызовы выполнялись бы дважды. Типы/лейблы оставлены — старые
// сохранённые статусы могут содержать эти шаги.
const STEP_ORDER: RefreshAllStepId[] = ['hierarchy', 'comments', 'billing', 'detalization', 'subscribers'];

// Пул одновременных вызовов внутри шага: упираемся в rate-gate аккаунта,
// а не в RTT последовательных запросов.
const STEP_POOL = 3;

export interface IRefreshAllStep {
  accountId: string;
  accountLabel: string;
  step: RefreshAllStepId;
  label: string;
  status: RefreshAllStepStatus;
  count: number | null;
  message: string | null;
}

export interface IRefreshAllStatus {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  window: { dateFrom: string; dateTo: string } | null;
  steps: IRefreshAllStep[];
  error: string | null;
  /** Кто запустил прогон. Опционально: старые сохранённые статусы поля не имеют. */
  initiator?: 'manual' | 'schedule';
}

let currentStatus: IRefreshAllStatus | null = null;
let runInFlight = false;

const getMoscowYmd = (now: Date): string => {
  const formatter = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = formatter.formatToParts(now);
  const get = (type: string): string => parts.find(p => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
};

/** Окно детализации по умолчанию: с 1-го числа текущего месяца (МСК) по сегодня. */
export const defaultDetalizationWindow = (now: Date = new Date()): { dateFrom: string; dateTo: string } => {
  const today = getMoscowYmd(now);
  return { dateFrom: `${today.slice(0, 7)}-01`, dateTo: today };
};

/** Ошибок нет → ok; только 1010 без единого успеха → unavailable; иначе error. */
const stepStatusFromCounters = (c: { failed: number; unavailable: number; hadAnySuccess: boolean }): RefreshAllStepStatus => {
  if (c.failed > 0) return 'error';
  if (c.unavailable > 0 && !c.hadAnySuccess) return 'unavailable';
  return 'ok';
};

const UNAVAILABLE_MESSAGE = 'Не подключено в тарифе МТС — обратитесь к менеджеру МТС';

async function persistStatus(status: IRefreshAllStatus): Promise<void> {
  await mergeSigurRuntimeState({ key: LEASE_KEY, meta: { status } }).catch(err =>
    console.error('[mts-biz-refresh-all] persist status failed:', (err as Error).message),
  );
}

interface IStepOutcome {
  status: RefreshAllStepStatus;
  count: number | null;
  message: string | null;
}

async function runStep(
  step: RefreshAllStepId,
  accountId: string,
  window: { dateFrom: string; dateTo: string },
): Promise<IStepOutcome> {
  switch (step) {
    case 'hierarchy': {
      const res = await refreshHierarchy(accountId);
      const status = stepStatusFromCounters({
        failed: res.failed, unavailable: res.unavailable, hadAnySuccess: res.orgNumbers > 0,
      });
      // count — номера СВОЕГО ЛС; вся организация и чужие ЛС — справкой в message
      // (токен видит все ЛС организации сразу, раньше цифра была одинаковой у всех).
      const notes = [
        res.discovered > 0 ? `новых: ${res.discovered}` : null,
        `в организации: ${res.orgNumbers}`,
        res.foreignNumbers > 0 ? `другие ЛС: ${res.foreignNumbers}` : null,
      ].filter(Boolean).join(', ');
      return {
        status,
        count: res.totalNumbers,
        message: status === 'unavailable'
          ? UNAVAILABLE_MESSAGE
          : status === 'error'
            ? 'Ошибка запроса структуры абонента'
            : notes,
      };
    }
    case 'fio': {
      const msisdns = await mtsBusinessMappingService.getNumbersNeedingFio(accountId);
      if (msisdns.length === 0) {
        return { status: 'ok', count: 0, message: 'нет номеров без ФИО' };
      }
      const res = await refreshFioForNumbers(accountId, msisdns);
      const status = stepStatusFromCounters({
        failed: res.failed, unavailable: res.unavailable, hadAnySuccess: res.fetched > 0 || res.unavailable + res.failed < res.requested,
      });
      return {
        status,
        count: res.fetched,
        message: status === 'unavailable'
          ? UNAVAILABLE_MESSAGE
          : status === 'error'
            ? `${res.failed} из ${res.requested} номеров с ошибкой`
            : `получено ФИО: ${res.fetched} из ${res.requested}`,
      };
    }
    case 'comments': {
      const msisdns = await mtsBusinessMappingService.getAllKnownMsisdnsByAccount(accountId);
      if (msisdns.length === 0) {
        return { status: 'ok', count: 0, message: 'нет известных номеров' };
      }
      try {
        const comments = await mtsBusinessCatalogService.getCommentsByMsisdn(accountId, msisdns);
        const pairs = [...comments.entries()].map(([msisdn, comment]) => ({ msisdn, comment }));
        const { saved } = await mtsBusinessMappingService.syncMtsComments(pairs, accountId);
        return { status: 'ok', count: saved, message: `комментариев: ${saved}` };
      } catch (error) {
        if (isFeatureUnavailable(error)) return { status: 'unavailable', count: null, message: UNAVAILABLE_MESSAGE };
        return { status: 'error', count: null, message: 'Ошибка чтения комментариев' };
      }
    }
    case 'billing': {
      const res = await refreshAccountMetrics(accountId);
      // Попыток ≈ numbers (баланс по номерам) + 3 (баланс ЛС, неоплата, начисления bulk).
      const attempts = res.numbers + 3;
      const status = stepStatusFromCounters({
        failed: res.failed, unavailable: res.unavailable, hadAnySuccess: attempts - res.failed - res.unavailable > 0,
      });
      return {
        status,
        count: res.numbers,
        message: status === 'unavailable'
          ? UNAVAILABLE_MESSAGE
          : status === 'error'
            ? `${res.failed} запросов с ошибкой`
            : res.unavailable > 0 ? `часть данных не подключена в тарифе (${res.unavailable})` : null,
      };
    }
    case 'detalization': {
      const msisdns = await mtsBusinessMappingService.getAllKnownMsisdnsByAccount(accountId);
      if (msisdns.length === 0) {
        return { status: 'ok', count: 0, message: 'нет известных номеров — сначала обновите структуру' };
      }
      // syncMsisdnsBatch пишет и звонки, и начисления (charges_amount с
      // 1-го числа месяца) — «Обновить всё» освежает колонку «Начисления».
      // Упавшие номера добираются вторым проходом внутри helper'а.
      const res = await syncMsisdnsBatch(accountId, msisdns, window.dateFrom, window.dateTo, STEP_POOL);
      // «Нет доступа» точечно — свойство номеров; 401 по ВСЕМ номерам — почти
      // наверняка умерли креды аккаунта, маскировать это «ок»-статусом нельзя.
      if (res.noAccess === msisdns.length) {
        return { status: 'error', count: 0, message: '401 по всем номерам — проверьте логин/пароль аккаунта МТС' };
      }
      const status = stepStatusFromCounters({
        failed: res.failed, unavailable: res.unavailable, hadAnySuccess: res.unavailable + res.failed < msisdns.length,
      });
      const breakdown = formatMtsErrorBreakdown(res.errorBreakdown);
      const notes = [
        res.noAccess ? `нет доступа: ${res.noAccess}` : null,
        res.transient ? `МТС временно недоступен: ${res.transient}` : null,
      ].filter(Boolean).join(', ');
      return {
        status,
        count: res.inserted,
        message: status === 'unavailable'
          ? UNAVAILABLE_MESSAGE
          : status === 'error'
            ? `${res.failed} из ${msisdns.length} номеров с ошибкой${breakdown ? ` (${breakdown})` : ''}${notes ? `, ${notes}` : ''}`
            : `новых звонков: ${res.inserted}${notes ? `, ${notes}` : ''}`,
      };
    }
    case 'catalog': {
      const res = await refreshTariffAndServices(accountId);
      const attempts = res.numbers * 2 + 1;
      const status = stepStatusFromCounters({
        failed: res.failed, unavailable: res.unavailable, hadAnySuccess: attempts - res.failed - res.unavailable > 0,
      });
      return {
        status,
        count: res.numbers,
        message: status === 'unavailable'
          ? UNAVAILABLE_MESSAGE
          : status === 'error'
            ? `${res.failed} запросов с ошибкой`
            : res.unavailable > 0 ? `часть данных не подключена в тарифе (${res.unavailable})` : null,
      };
    }
    case 'subscribers': {
      // Bulk-профиль каждого номера (~5 вызовов/номер: персданные со skip по
      // свежести, тариф, абонплата, услуги, блокировки) — самый тяжёлый шаг,
      // идёт последним; питает вкладку «Абоненты».
      const res = await syncAccountSubscribers(accountId);
      if (res.numbers === 0) {
        return { status: 'ok', count: 0, message: 'нет известных номеров' };
      }
      if (res.noAccessNumbers === res.numbers) {
        return { status: 'error', count: 0, message: '401 по всем номерам — проверьте логин/пароль аккаунта МТС' };
      }
      const status = stepStatusFromCounters({
        failed: res.failed, unavailable: res.unavailable, hadAnySuccess: res.stored > 0,
      });
      const breakdown = formatMtsErrorBreakdown(res.errorBreakdown);
      // Стабильные состояния номеров — информация для админа, не сбой прогона.
      const notes = [
        res.noAccessNumbers ? `нет доступа: ${res.noAccessNumbers}` : null,
        res.noBindingNumbers ? `без связки ТП: ${res.noBindingNumbers}` : null,
        res.noPdNumbers ? `без персданных: ${res.noPdNumbers}` : null,
        res.unavailable ? `не в тарифе: ${res.unavailable}` : null,
        res.transient ? `МТС временно недоступен: ${res.transient}` : null,
      ].filter(Boolean).join(', ');
      return {
        status,
        count: res.numbers,
        message: status === 'unavailable'
          ? UNAVAILABLE_MESSAGE
          : status === 'error'
            ? `${res.failed} секций с ошибкой${breakdown ? ` (${breakdown})` : ''}${notes ? `, ${notes}` : ''}`
            : `секций сохранено: ${res.stored}${res.pdSkipped ? `, персданные свежие: ${res.pdSkipped}` : ''}${notes ? `, ${notes}` : ''}`,
      };
    }
  }
}

async function runRefreshAll(
  accounts: Array<{ id: string; label: string }>,
  window: { dateFrom: string; dateTo: string },
  owner: string,
): Promise<void> {
  const status = currentStatus;
  if (!status) return;
  const stopHeartbeat = startSigurRuntimeLeaseHeartbeat({
    key: LEASE_KEY,
    owner,
    ttlSeconds: LEASE_TTL_SECONDS,
    onError: err => console.error('[mts-biz-refresh-all] heartbeat failed:', err.message),
  });

  try {
    // Аккаунты — ПАРАЛЛЕЛЬНО: rate-gate у каждого аккаунта свой (лимит МТС —
    // на Consumer Key), поэтому общее время = максимум по аккаунтам, а не сумма.
    // Шаги внутри аккаунта — последовательно (детализации нужен инвентарь и т.д.).
    await Promise.all(accounts.map(async account => {
      for (const stepId of STEP_ORDER) {
        const entry = status.steps.find(s => s.accountId === account.id && s.step === stepId);
        if (!entry) continue;
        entry.status = 'running';
        await persistStatus(status);
        try {
          const outcome = await runStep(stepId, account.id, window);
          entry.status = outcome.status;
          entry.count = outcome.count;
          entry.message = outcome.message;
        } catch (error) {
          entry.status = isFeatureUnavailable(error) ? 'unavailable' : 'error';
          entry.message = entry.status === 'unavailable'
            ? UNAVAILABLE_MESSAGE
            : (error instanceof Error ? error.message : 'unknown').slice(0, 200);
          if (entry.status === 'error') {
            console.error(`[mts-biz-refresh-all] step=${stepId} account="${account.label}" —`, error instanceof Error ? error.message : 'unknown');
          }
        }
        await persistStatus(status);
        console.log(`[mts-biz-refresh-all] account="${account.label}" step=${stepId} → ${entry.status}${entry.count != null ? ` count=${entry.count}` : ''}`);
      }
    }));
  } catch (error) {
    status.error = error instanceof Error ? error.message : 'unknown';
    console.error('[mts-biz-refresh-all] прогон упал:', status.error);
    Sentry.captureException(error, { tags: { module: 'mts-business', kind: 'refresh-all' } });
  } finally {
    status.running = false;
    status.finishedAt = new Date().toISOString();
    // Незавершённые шаги (прогон упал целиком) не должны остаться «pending/running».
    for (const s of status.steps) {
      if (s.status === 'pending' || s.status === 'running') {
        s.status = 'error';
        s.message = s.message ?? 'Прервано';
      }
    }
    await persistStatus(status);
    stopHeartbeat();
    await releaseSigurRuntimeLease({ key: LEASE_KEY, owner }).catch(err =>
      console.error('[mts-biz-refresh-all] release lease failed:', (err as Error).message),
    );
    runInFlight = false;
    console.log('[mts-biz-refresh-all] прогон завершён');
  }
}

export async function startRefreshAll(opts: {
  accountId?: string;
  dateFrom?: string;
  dateTo?: string;
  initiator?: 'manual' | 'schedule';
}): Promise<{ started: boolean; alreadyRunning?: boolean; completion?: Promise<IRefreshAllStatus> }> {
  if (runInFlight) return { started: false, alreadyRunning: true };

  const all = await mtsBusinessAccountsService.list();
  const accounts = (opts.accountId ? all.filter(a => a.id === opts.accountId) : all.filter(a => a.isActive))
    .map(a => ({ id: a.id, label: a.label }));
  if (accounts.length === 0) {
    throw new Error('МТС Бизнес: аккаунт не найден или нет активных аккаунтов');
  }

  const owner = getSigurRuntimeOwner(LEASE_KEY);
  const acq = await tryAcquireSigurRuntimeLease({ key: LEASE_KEY, owner, ttlSeconds: LEASE_TTL_SECONDS });
  if (!acq.acquired) return { started: false, alreadyRunning: true };

  const window = opts.dateFrom && opts.dateTo
    ? { dateFrom: opts.dateFrom, dateTo: opts.dateTo }
    : defaultDetalizationWindow();

  runInFlight = true;
  currentStatus = {
    running: true,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    window,
    initiator: opts.initiator ?? 'manual',
    steps: accounts.flatMap(account =>
      STEP_ORDER.map(step => ({
        accountId: account.id,
        accountLabel: account.label,
        step,
        label: REFRESH_ALL_STEP_LABELS[step],
        status: 'pending' as RefreshAllStepStatus,
        count: null,
        message: null,
      })),
    ),
    error: null,
  };
  await persistStatus(currentStatus);

  console.log(`[mts-biz-refresh-all] старт accounts=${accounts.length} window=${window.dateFrom}..${window.dateTo} initiator=${currentStatus.initiator}`);
  // runRefreshAll мутирует статус in-place и никогда не бросает (всё в finally),
  // поэтому completion резолвится итоговым статусом. Ручной контроллер его
  // игнорирует, планировщик — ждёт для записи итога прогона.
  const statusRef = currentStatus;
  const completion = runRefreshAll(accounts, window, owner)
    .catch(err => console.error('[mts-biz-refresh-all] runRefreshAll rejected:', (err as Error).message))
    .then(() => statusRef);
  return { started: true, completion };
}

// Порог «прогон мёртв» по heartbeat: heartbeat идёт каждые TTL/3 (~200с);
// 450с без heartbeat = минимум два пропущенных бита → держатель lease погиб.
const HEARTBEAT_STALE_MS = 450_000;

const markInterrupted = (stored: IRefreshAllStatus, finishedAt: string | null): IRefreshAllStatus => ({
  ...stored,
  running: false,
  finishedAt: stored.finishedAt ?? finishedAt ?? new Date().toISOString(),
  error: stored.error ?? 'Обновление прервано (сервер перезапущен) — запустите заново',
  steps: stored.steps.map(s =>
    s.status === 'pending' || s.status === 'running'
      ? { ...s, status: 'error' as RefreshAllStepStatus, message: s.message ?? 'Прервано' }
      : s,
  ),
});

/**
 * Текущий/последний статус прогона. Если процесс с активным прогоном — из
 * памяти; иначе из runtime_state (последний persist). Если сохранённый статус
 * «running», но lease истёк ИЛИ heartbeat молчит дольше двух интервалов
 * (сервер перезапустился/упал посреди прогона) — показываем прогон прерванным,
 * чтобы фронт не крутил спиннер вечно.
 */
export async function getRefreshAllStatus(): Promise<IRefreshAllStatus> {
  if (runInFlight && currentStatus) return currentStatus;

  const state = await getSigurRuntimeState(LEASE_KEY);
  const stored = state?.meta?.status as IRefreshAllStatus | undefined;
  if (!stored || typeof stored !== 'object' || !Array.isArray(stored.steps)) {
    return { running: false, startedAt: null, finishedAt: null, window: null, steps: [], error: null };
  }
  if (stored.running) {
    const leaseAlive = state?.lease_expires_at != null && Date.parse(state.lease_expires_at) > Date.now();
    const heartbeatAlive = state?.heartbeat_at != null && Date.parse(state.heartbeat_at) > Date.now() - HEARTBEAT_STALE_MS;
    if (!leaseAlive || !heartbeatAlive) {
      return markInterrupted(stored, state?.updated_at ?? null);
    }
  }
  return stored;
}

/**
 * Реанимация при старте сервера: если в runtime_state завис «running»-прогон,
 * а его владелец — прежний процесс ЭТОГО ЖЕ хоста и он мёртв (деплой/рестарт
 * убил процесс посреди прогона), сразу помечаем прогон прерванным и снимаем
 * lease — без этого кнопка «Обновить» блокировалась бы до 10 минут (TTL lease).
 * Владельца с другого хоста или живой процесс не трогаем.
 */
export async function reconcileInterruptedRefreshAll(): Promise<void> {
  try {
    const state = await getSigurRuntimeState(LEASE_KEY);
    const stored = state?.meta?.status as IRefreshAllStatus | undefined;
    if (!stored || typeof stored !== 'object' || stored.running !== true || !Array.isArray(stored.steps)) return;

    const owner = state?.lease_owner ?? null;
    const leaseAlive = state?.lease_expires_at != null && Date.parse(state.lease_expires_at) > Date.now();
    let ownerDead = !leaseAlive || owner == null;

    if (!ownerDead && owner != null) {
      // owner = `${scope}:${hostname}:${pid}:${rand}` (см. getSigurRuntimeOwner).
      const parts = owner.split(':');
      const ownerHost = parts.length >= 4 ? parts[parts.length - 3] : null;
      const ownerPid = parts.length >= 4 ? Number.parseInt(parts[parts.length - 2], 10) : NaN;
      if (ownerHost === hostname() && Number.isFinite(ownerPid) && ownerPid !== process.pid) {
        try {
          process.kill(ownerPid, 0); // сигнал 0 — только проверка существования
        } catch {
          ownerDead = true;
        }
      }
    }
    if (!ownerDead) return;

    await mergeSigurRuntimeState({ key: LEASE_KEY, meta: { status: markInterrupted(stored, state?.updated_at ?? null) } });
    if (owner) {
      await releaseSigurRuntimeLease({ key: LEASE_KEY, owner }).catch(() => undefined);
    }
    console.log('[mts-biz-refresh-all] незавершённый прогон помечен прерванным (рестарт сервера)');
  } catch (e) {
    console.error('[mts-biz-refresh-all] reconcile failed:', e instanceof Error ? e.message : 'unknown');
  }
}
