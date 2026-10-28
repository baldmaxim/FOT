/**
 * Доли бригад для расчёта ФОТ месяца (payroll-calc.service): закрытый расчёт — зафиксированные доли; «Расчёты» —
 * ещё и предварительные доли открытых бригад и их состав (payroll-calc-preliminary.service).
 *
 * Расчёты бригад (getBrigadeShares — транзакция с блокировкой бригады, около 8 обращений к БД) — не больше трёх
 * одновременно на весь процесс: у пула 10 соединений, остальным запросам портала нужно место.
 */
import type { AuthenticatedRequest } from '../../types/index.js';
import { createConcurrencyLimiter } from '../../utils/concurrency-limiter.js';
import { getBrigadeShares, type IBrigadeShares } from './brigade-salary.service.js';
import {
  loadBrigadeCandidates,
  loadBrigadeContext,
  resolveOpenBrigadeShares,
  type IBrigadeContext,
} from './payroll-calc-preliminary.service.js';

const BRIGADE_SHARES_CONCURRENCY = 3;
const withBrigadeSlot = createConcurrencyLimiter(BRIGADE_SHARES_CONCURRENCY);

/** Доли бригад месяца: какие посчитаны предварительно, контексты открытых и кандидатов. */
export interface IBrigadeStep {
  shares: Map<string, IBrigadeShares>;
  preliminary: Set<string>;
  contexts: IBrigadeContext[];
}

/** Закрытый расчёт: зафиксированные доли бригад основ, по одной на бригаду, не больше трёх одновременно. */
export const loadFixedBrigadeShares = async (
  req: AuthenticatedRequest,
  month: string,
  brigadeIds: readonly string[],
): Promise<IBrigadeStep> => {
  const results = await Promise.all(brigadeIds.map(departmentId => (
    withBrigadeSlot(() => getBrigadeShares(req, departmentId, month))
  )));
  return {
    shares: new Map(brigadeIds.map((departmentId, index) => [departmentId, results[index]])),
    preliminary: new Set(),
    contexts: [],
  };
};

/**
 * Предварительный расчёт: бригады основ и кандидаты сотрудников с незакрытым месяцем. Слот — один на весь путь
 * бригады (фиксация → состав → выработка → доли); внутри лимитер не берётся: вложенный захват трёх слотов ждал бы
 * сам себя. Состав грузится, если бригада открыта или в ней могли быть дни незакрытых сотрудников.
 */
export const loadPreliminaryBrigadeShares = async (
  req: AuthenticatedRequest,
  month: string,
  asOf: string,
  brigadeIds: readonly string[],
  liveIds: readonly number[],
): Promise<IBrigadeStep> => {
  const candidates = new Set(await loadBrigadeCandidates(liveIds, `${month}-01`, asOf));
  const ids = [...new Set([...brigadeIds, ...candidates])].sort();
  const results = await Promise.all(ids.map(departmentId => withBrigadeSlot(async () => {
    const fixed = await getBrigadeShares(req, departmentId, month);
    const context = fixed.state !== 'fixed' || candidates.has(departmentId)
      ? await loadBrigadeContext(departmentId, `${month}-01`, asOf)
      : null;
    if (fixed.state === 'fixed' || !context) return { shares: fixed, context, preliminary: false };
    return { shares: await resolveOpenBrigadeShares(context, month, asOf), context, preliminary: true };
  })));
  return {
    shares: new Map(ids.map((departmentId, index) => [departmentId, results[index].shares])),
    preliminary: new Set(ids.filter((_, index) => results[index].preliminary)),
    contexts: results.flatMap(item => (item.context ? [item.context] : [])),
  };
};
