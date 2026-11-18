/**
 * Привести плановые («штатные») доплаты сотрудников к списку — таблице «Доплата штатная» из 1С (решение пользователя
 * 28.10.2026: «нужно, чтобы были вот эти»). Список — цель: у сотрудника ровно эти действующие доплаты, пустой список —
 * доплат нет.
 *
 * Строки — те же, что у окна сотрудника и «Справочника» (миграция 369: каждая неархивная строка с суммой —
 * самостоятельная доплата). Запись — разницей под блокировкой сотрудника, чтобы «История изменений» не теряла событий:
 * доплата, совпавшая с периодом цели (сумма и даты), не трогается; лишняя — снимается («снята»); недостающая —
 * добавляется без комментария («назначена»). Совпадает с целью — сотрудник не трогается, повторный запуск ничего не
 * пишет. После записи доплаты перечитываются в той же транзакции: не равны цели — откат. Сухой прогон пишет и
 * откатывает — «станет» показывает сама БД.
 * До записи: ФИО каждого сотрудника сверяется с id, у сотрудника в цели нет двух одинаковых периодов — одно
 * несовпадение — ничего не пишется.
 */
import type { PoolClient } from 'pg';

import { pool, query } from '../../config/postgres.js';
import {
  insertPlannedPeriod,
  readPlannedPeriods,
  replacePlannedPeriod,
  type IPlannedPeriod,
} from './payroll-planned-supplement-rows.js';
import { lockPayrollEmployee, type IPlannedSupplementValue } from './payroll-terms.service.js';

export interface IPlannedSupplementTarget {
  employeeId: number;
  /** ФИО, как в списке: сверяется с employees.full_name (без учёта регистра и ё/е). */
  fullName: string;
  /** Действующие периоды; пусто — доплату снять. */
  periods: IPlannedSupplementValue[];
}

export interface IPlannedSupplementSyncItem {
  employeeId: number;
  fullName: string;
  before: IPlannedSupplementValue[];
  after: IPlannedSupplementValue[];
  /** same — уже как в списке; changed — приведено (при сухом прогоне откатано). */
  status: 'same' | 'changed';
}

export class PlannedSupplementSyncError extends Error {}

const normalizeName = (name: string): string => name.trim().replace(/\s+/g, ' ').toLowerCase().replace(/ё/g, 'е');

const toCents = (amount: number): number => Math.round(amount * 100);

/** Порядок для сравнения: дата начала, дата окончания (бессрочно — последней), сумма — одинаковое начало не мешает. */
const comparePeriods = (a: IPlannedSupplementValue, b: IPlannedSupplementValue): number => (
  a.dateFrom.localeCompare(b.dateFrom)
  || (a.dateTo ?? '9999-12-31').localeCompare(b.dateTo ?? '9999-12-31')
  || toCents(a.amount) - toCents(b.amount)
);

const sortPeriods = (periods: readonly IPlannedSupplementValue[]): IPlannedSupplementValue[] => (
  [...periods].sort(comparePeriods)
);

/** Тот же период (сумма и даты; комментарий синк не сравнивает — 1С его не знает). */
const samePeriod = (a: IPlannedSupplementValue, b: IPlannedSupplementValue): boolean => (
  toCents(a.amount) === toCents(b.amount) && a.dateFrom === b.dateFrom && a.dateTo === b.dateTo
);

export const samePeriods = (a: readonly IPlannedSupplementValue[], b: readonly IPlannedSupplementValue[]): boolean => {
  const left = sortPeriods(a);
  const right = sortPeriods(b);
  return left.length === right.length && left.every((period, index) => samePeriod(period, right[index]));
};

/** У сотрудника в цели нет двух одинаковых периодов: две одинаковые доплаты не заводим (как и в «Справочнике»). */
const hasDuplicatePeriods = (periods: readonly IPlannedSupplementValue[]): boolean => (
  periods.some((period, index) => periods.slice(index + 1).some(other => samePeriod(period, other)))
);

const toValues = (periods: readonly IPlannedPeriod[]): IPlannedSupplementValue[] => (
  sortPeriods(periods.map(period => ({ amount: period.amount, dateFrom: period.dateFrom, dateTo: period.dateTo })))
);

/** Записать цель одного сотрудника в открытой транзакции — разницей; вернуть доплаты до и после. */
const syncOne = async (
  client: PoolClient,
  target: IPlannedSupplementTarget,
): Promise<IPlannedSupplementSyncItem> => {
  await lockPayrollEmployee(client, target.employeeId);
  const current = await readPlannedPeriods(client, target.employeeId);
  const before = toValues(current);
  if (samePeriods(before, target.periods)) {
    return { employeeId: target.employeeId, fullName: target.fullName, before, after: before, status: 'same' };
  }
  // Совпавшие с целью доплаты остаются как есть (с комментарием), каждая закрывает один период цели.
  const missing = sortPeriods(target.periods);
  const extra: IPlannedPeriod[] = [];
  for (const period of current) {
    const index = missing.findIndex(item => samePeriod(item, period));
    if (index === -1) extra.push(period);
    else missing.splice(index, 1);
  }
  for (const period of extra) {
    await replacePlannedPeriod(client, { employeeId: target.employeeId, target: period, value: null, createdBy: null });
  }
  // Список 1С без комментариев (миграция 364).
  for (const period of missing) {
    await insertPlannedPeriod(client, {
      employeeId: target.employeeId,
      value: { amount: period.amount, dateFrom: period.dateFrom, dateTo: period.dateTo, comment: null },
      createdBy: null,
    });
  }
  const after = toValues(await readPlannedPeriods(client, target.employeeId));
  if (!samePeriods(after, target.periods)) {
    throw new PlannedSupplementSyncError(
      `${target.fullName}: после записи периоды ${JSON.stringify(after)} не равны списку ${JSON.stringify(sortPeriods(target.periods))}`,
    );
  }
  return { employeeId: target.employeeId, fullName: target.fullName, before, after, status: 'changed' };
};

export const syncPlannedSupplements = async (
  targets: readonly IPlannedSupplementTarget[],
  options: { apply: boolean },
): Promise<IPlannedSupplementSyncItem[]> => {
  const ids = targets.map(target => target.employeeId);
  if (new Set(ids).size !== ids.length) throw new PlannedSupplementSyncError('Сотрудник в списке дважды');
  const names = new Map((await query<{ id: number; full_name: string | null }>(
    'SELECT id, full_name FROM employees WHERE id = ANY($1::int[])',
    [ids],
  )).map(row => [Number(row.id), row.full_name]));
  const duplicated = targets.filter(target => hasDuplicatePeriods(target.periods));
  if (duplicated.length > 0) {
    throw new PlannedSupplementSyncError(`Одинаковые периоды у сотрудника: ${duplicated
      .map(target => `${target.employeeId} «${target.fullName}»`)
      .join('; ')}`);
  }
  const mismatched = targets.filter(target => normalizeName(names.get(target.employeeId) ?? '') !== normalizeName(target.fullName));
  if (mismatched.length > 0) {
    throw new PlannedSupplementSyncError(`ФИО не совпадает с id: ${mismatched
      .map(target => `${target.employeeId} «${target.fullName}» ≠ «${names.get(target.employeeId) ?? 'нет такого'}»`)
      .join('; ')}`);
  }

  // Одна транзакция на весь список: ошибка у любого — не записано ничего; сухой прогон — откат в конце.
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    const items: IPlannedSupplementSyncItem[] = [];
    for (const target of targets) items.push(await syncOne(client, target));
    await client.query(options.apply ? 'COMMIT' : 'ROLLBACK');
    return items;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};
