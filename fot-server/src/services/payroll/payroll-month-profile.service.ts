/**
 * Профиль пары «сотрудник + месяц» для фильтра «Объект» на «Расчётах» — тем же путём, что объект строки «Свода»
 * (payroll-summary.service, buildSummary): разбивка закрытого табеля → объект месяца (attributeMonths) → для «Не
 * определён» — режим месяца, затем часы по проходам (resolveSummaryObjects). «Свод» этим модулем не пользуется — порядок
 * шагов повторён, и PG-тест сверяет их на одних парах.
 *
 * Кэш по паре, TTL 2 минуты: «Расчёты» догружают список порциями подряд, и без кэша профиль всего штата считался бы на
 * каждую порцию. Берутся закэшированные пары, считаются только недостающие; одинаковые вычисления в полёте общие.
 * Правка режима или закрытие табеля видны фильтру с задержкой до 2 минут — осознанно.
 */
import { performance } from 'node:perf_hooks';

import { query } from '../../config/postgres.js';
import { attributeMonths, loadMonthBreakdown, type IMonthEmployee } from './payroll-month-attribution.service.js';
import { monthProfileKey, type IMonthPair, type IMonthProfile } from './payroll-month-profile.rules.js';
import { resolveSummaryObjects } from './payroll-summary-object.service.js';
import { SUMMARY_UNKNOWN } from './payroll-summary.attribution.js';

const PROFILE_TTL_MS = 2 * 60_000;
/** Предел кэша: весь штат за 12 месяцев с запасом. */
const PROFILE_CACHE_MAX = 30_000;
/** Расчёт дольше — строка в лог: по ней видно, что фильтр тормозит. */
const PROFILE_LOG_THRESHOLD_MS = 2000;

const cache = new Map<string, { at: number; profile: IMonthProfile }>();
const inFlight = new Map<string, Promise<Map<string, IMonthProfile>>>();

/** Для тестов: следующий запрос считает заново. */
export const clearMonthProfileCache = (): void => {
  cache.clear();
  inFlight.clear();
};

/** Профили пар без кэша — порядок шагов как в buildSummary. */
const computeMonthProfiles = async (pairs: readonly IMonthPair[]): Promise<Map<string, IMonthProfile>> => {
  const started = performance.now();
  const employeeIds = [...new Set(pairs.map(pair => pair.employeeId))];
  const monthStarts = [...new Set(pairs.map(pair => `${pair.month}-01`))];
  const [employeeRows, breakdown] = await Promise.all([
    query<{ id: number; org_department_id: string | null; employment_status: string | null }>(
      `SELECT id, org_department_id::text AS org_department_id, employment_status
         FROM employees WHERE id = ANY($1::int[])`,
      [employeeIds],
    ),
    loadMonthBreakdown(monthStarts, employeeIds),
  ]);
  const employees = new Map<number, IMonthEmployee>(employeeRows.map(row => [Number(row.id), row]));
  const attribution = await attributeMonths(pairs, breakdown, employees);
  // Объект, где базовый «Не определён»: режим месяца, затем часы.
  const summaryObjects = await resolveSummaryObjects(attribution);

  const result = new Map<string, IMonthProfile>();
  for (const pair of pairs) {
    const key = monthProfileKey(pair.employeeId, pair.month);
    result.set(key, { object: summaryObjects.get(key) ?? attribution.get(key)?.object ?? SUMMARY_UNKNOWN });
  }
  const elapsed = performance.now() - started;
  if (elapsed > PROFILE_LOG_THRESHOLD_MS) {
    console.log(`[payroll-month-profile] ${pairs.length} пар (${employeeIds.length} чел., ${monthStarts.length} мес.): ${Math.round(elapsed)} мс`);
  }
  return result;
};

/** Запись в кэш: истёкшие удаляются, сверх предела — самые старые. */
const remember = (profiles: ReadonlyMap<string, IMonthProfile>, at: number): void => {
  for (const [key, profile] of profiles) {
    cache.delete(key);
    cache.set(key, { at, profile });
  }
  if (cache.size <= PROFILE_CACHE_MAX) return;
  for (const [key, entry] of cache) {
    if (at - entry.at > PROFILE_TTL_MS) cache.delete(key);
  }
  for (const key of cache.keys()) {
    if (cache.size <= PROFILE_CACHE_MAX) break;
    cache.delete(key);
  }
};

/** Профили пар (ключ — monthProfileKey). now — для тестов TTL. */
export const loadMonthProfiles = async (
  pairs: readonly IMonthPair[],
  now: () => number = Date.now,
): Promise<Map<string, IMonthProfile>> => {
  const result = new Map<string, IMonthProfile>();
  const waits = new Map<Promise<Map<string, IMonthProfile>>, string[]>();
  const missing = new Map<string, IMonthPair>();
  const started = now();
  for (const pair of pairs) {
    const key = monthProfileKey(pair.employeeId, pair.month);
    if (result.has(key) || missing.has(key)) continue;
    const cached = cache.get(key);
    if (cached && started - cached.at <= PROFILE_TTL_MS) {
      result.set(key, cached.profile);
      continue;
    }
    const pending = inFlight.get(key);
    if (pending) {
      const keys = waits.get(pending);
      if (keys) keys.push(key);
      else waits.set(pending, [key]);
      continue;
    }
    missing.set(key, pair);
  }

  if (missing.size > 0) {
    const promise = computeMonthProfiles([...missing.values()]);
    for (const key of missing.keys()) inFlight.set(key, promise);
    waits.set(promise, [...missing.keys()]);
    promise
      .then(profiles => remember(profiles, now()))
      .catch(() => undefined)
      .finally(() => {
        for (const key of missing.keys()) {
          if (inFlight.get(key) === promise) inFlight.delete(key);
        }
      });
  }

  for (const [promise, keys] of waits) {
    const profiles = await promise;
    for (const key of keys) {
      const profile = profiles.get(key);
      if (profile) result.set(key, profile);
    }
  }
  return result;
};
