/**
 * Доли бригад для расчёта ФОТ месяца (payroll-calc.service): закрытый расчёт — зафиксированные доли; «Расчёты» —
 * ещё и предварительные доли открытых бригад и их состав (payroll-calc-preliminary.service).
 *
 * Доли сначала читаются пакетом (peekBrigadeSharesMany — один снимок на все бригады месяца). Фиксация закрытого месяца
 * без актуального расчёта (getBrigadeShares — транзакция с блокировкой бригады, около 8 обращений к БД) и состав
 * бригады — не больше трёх одновременно на весь процесс: у пула 10 соединений, остальным запросам портала нужно место.
 */
import type { AuthenticatedRequest } from '../../types/index.js';
import { createConcurrencyLimiter } from '../../utils/concurrency-limiter.js';
import {
  getBrigadeShares,
  peekBrigadeShares,
  peekBrigadeSharesMany,
  type IBrigadeShares,
} from './brigade-salary.service.js';
import {
  loadBrigadeCandidates,
  loadBrigadeContexts,
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

/**
 * Закрытый расчёт: зафиксированные доли бригад основ. Актуальные сохранённые и незакрытые — из пакета, фиксация
 * (needs_fix) — getBrigadeShares по одной на бригаду, не больше трёх одновременно.
 */
export const loadFixedBrigadeShares = async (
  req: AuthenticatedRequest,
  month: string,
  brigadeIds: readonly string[],
): Promise<IBrigadeStep> => {
  const peeked = await peekBrigadeSharesMany(brigadeIds, month);
  const results = await Promise.all(brigadeIds.map(departmentId => {
    const peek = peeked.get(departmentId)!;
    return peek.state === 'needs_fix' ? withBrigadeSlot(() => getBrigadeShares(req, departmentId, month)) : peek.shares;
  }));
  return {
    shares: new Map(brigadeIds.map((departmentId, index) => [departmentId, results[index]])),
    preliminary: new Set(),
    contexts: [],
  };
};

/**
 * Закрытый расчёт без записи (расчётный лист в ЛК): только уже зафиксированные актуальные доли (peekBrigadeShares),
 * иначе бригада open. Слот тот же — чтение входов бригады не дешевле.
 */
export const peekFixedBrigadeShares = async (
  month: string,
  brigadeIds: readonly string[],
): Promise<IBrigadeStep> => {
  const results = await Promise.all(brigadeIds.map(departmentId => (
    withBrigadeSlot(() => peekBrigadeShares(departmentId, month))
  )));
  return {
    shares: new Map(brigadeIds.map((departmentId, index) => [departmentId, results[index]])),
    preliminary: new Set(),
    contexts: [],
  };
};

/**
 * Предварительный расчёт: бригады основ и кандидаты сотрудников с незакрытым месяцем — в три шага.
 * 1. Итоговые доли: из пакета; фиксация (needs_fix) — getBrigadeShares в слоте, она может вернуть и open, если
 *    подачу успели открыть.
 * 2. Состав — одним вызовом на все бригады, где итог не fixed или в ней могли быть дни незакрытых сотрудников.
 * 3. Предварительные доли — только у итоговой open, в слоте: ввод открытой из пакета, после фиксации — читается заново.
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
  const peeked = await peekBrigadeSharesMany(ids, month);
  const fixed = await Promise.all(ids.map(departmentId => {
    const peek = peeked.get(departmentId)!;
    return peek.state === 'needs_fix' ? withBrigadeSlot(() => getBrigadeShares(req, departmentId, month)) : peek.shares;
  }));
  const contexts = await loadBrigadeContexts(
    ids.filter((departmentId, index) => fixed[index].state !== 'fixed' || candidates.has(departmentId)),
    `${month}-01`,
    asOf,
  );
  const results = await Promise.all(ids.map(async (departmentId, index) => {
    const shares = fixed[index];
    const context = contexts.get(departmentId) ?? null;
    if (shares.state === 'fixed' || !context) return { shares, context, preliminary: false };
    const peek = peeked.get(departmentId)!;
    const inputs = peek.state === 'open' ? peek.inputs : undefined;
    return {
      shares: await withBrigadeSlot(() => resolveOpenBrigadeShares(context, month, asOf, inputs)),
      context,
      preliminary: true,
    };
  }));
  return {
    shares: new Map(ids.map((departmentId, index) => [departmentId, results[index].shares])),
    preliminary: new Set(ids.filter((_, index) => results[index].preliminary)),
    contexts: results.flatMap(item => (item.context ? [item.context] : [])),
  };
};
