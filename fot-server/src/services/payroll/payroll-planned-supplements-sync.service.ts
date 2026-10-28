/**
 * Привести плановые («штатные») доплаты сотрудников к списку — таблице «Доплата штатная» из 1С (решение пользователя
 * 28.10.2026: «нужно, чтобы были вот эти»). Список — цель: у сотрудника ровно эти действующие периоды, пустой список —
 * доплаты нет.
 *
 * Журнал тот же, что у окна сотрудника и «Справочника» (миграция 293): пишется через setPlannedSupplement под
 * блокировкой сотрудника, версиями по порядку дат; действующие периоды — PLANNED_SUPPLEMENT_PERIODS_SQL. Совпадает
 * с целью — сотрудник не трогается, поэтому повторный запуск ничего не пишет. После записи периоды перечитываются в той
 * же транзакции: не равны цели — откат. Сухой прогон пишет и откатывает — «станет» показывает сама БД.
 * ФИО каждого сотрудника сверяется с id до любой записи: одно несовпадение — ничего не пишется.
 */
import type { PoolClient } from 'pg';

import { pool, query } from '../../config/postgres.js';
import { PLANNED_SUPPLEMENT_PERIODS_SQL } from './payroll-supplements.service.js';
import { lockPayrollEmployee, setPlannedSupplement, type IPlannedSupplementValue } from './payroll-terms.service.js';

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

const sortPeriods = (periods: readonly IPlannedSupplementValue[]): IPlannedSupplementValue[] => (
  [...periods].sort((a, b) => a.dateFrom.localeCompare(b.dateFrom))
);

export const samePeriods = (a: readonly IPlannedSupplementValue[], b: readonly IPlannedSupplementValue[]): boolean => {
  const left = sortPeriods(a);
  const right = sortPeriods(b);
  return left.length === right.length && left.every((period, index) => (
    toCents(period.amount) === toCents(right[index].amount)
    && period.dateFrom === right[index].dateFrom
    && period.dateTo === right[index].dateTo
  ));
};

const readPeriods = async (client: PoolClient, employeeId: number): Promise<IPlannedSupplementValue[]> => (
  (await client.query<{ amount: string; date_from: string; date_to: string | null }>(
    `SELECT p.amount::text AS amount, to_char(p.date_from, 'YYYY-MM-DD') AS date_from,
            to_char(p.date_to, 'YYYY-MM-DD') AS date_to
       FROM (${PLANNED_SUPPLEMENT_PERIODS_SQL}) p
      WHERE p.employee_id = $1
      ORDER BY p.date_from`,
    [employeeId],
  )).rows.map(row => ({ amount: Number(row.amount), dateFrom: row.date_from, dateTo: row.date_to }))
);

/** Записать цель одного сотрудника в открытой транзакции; вернуть периоды до и после. */
const syncOne = async (
  client: PoolClient,
  target: IPlannedSupplementTarget,
): Promise<IPlannedSupplementSyncItem> => {
  await lockPayrollEmployee(client, target.employeeId);
  const before = await readPeriods(client, target.employeeId);
  if (samePeriods(before, target.periods)) {
    return { employeeId: target.employeeId, fullName: target.fullName, before, after: before, status: 'same' };
  }
  const periods = sortPeriods(target.periods);
  if (periods.length === 0) {
    await setPlannedSupplement(client, { employeeId: target.employeeId, value: null, createdBy: null });
  }
  for (const period of periods) {
    await setPlannedSupplement(client, { employeeId: target.employeeId, value: period, createdBy: null });
  }
  const after = await readPeriods(client, target.employeeId);
  if (!samePeriods(after, target.periods)) {
    throw new PlannedSupplementSyncError(
      `${target.fullName}: после записи периоды ${JSON.stringify(after)} не равны списку ${JSON.stringify(periods)}`,
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
