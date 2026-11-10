/**
 * Сотрудник для физлица из выгрузки 1С (ведомости выплаты XML, реестр ФСС): по коду физлица (id_all), иначе по ФИО;
 * у тёзок — работавший в месяце (уволенный без даты увольнения — не работал), затем ранее подтверждённый под этим ФИО;
 * не решилось — без сотрудника. Кандидаты — matchPayoutLines (подрядчик в месяце не кандидат).
 */
import type { IPayoutCandidate } from '../../src/services/payroll/payroll-1c-payouts.matching.js';

export type DecisionKind = 'id_all' | 'single' | 'worked' | 'earlier' | 'ambiguous' | 'none';

export const DECISION_LABELS: ReadonlyArray<[DecisionKind, string]> = [
  ['id_all', 'по коду физлица 1С (id_all)'],
  ['single', 'один кандидат по ФИО'],
  ['worked', 'тёзка — работал в месяце'],
  ['earlier', 'тёзка — подтверждён ранее под этим ФИО'],
  ['ambiguous', 'тёзки — без сотрудника'],
  ['none', 'нет в ФОТ — без сотрудника'],
];

export const decisionLabel = (kind: DecisionKind): string => DECISION_LABELS.find(([k]) => k === kind)?.[1] ?? kind;

export interface IDecision { employeeId: number | null; kind: DecisionKind }

export const decide = (
  candidates: readonly IPayoutCandidate[], autoId: number | null, earlier: ReadonlySet<number>, firedNoDate: ReadonlySet<number>,
): IDecision => {
  if (autoId !== null) return { employeeId: autoId, kind: 'id_all' };
  if (candidates.length === 0) return { employeeId: null, kind: 'none' };
  if (candidates.length === 1) return { employeeId: candidates[0].employee_id, kind: 'single' };
  let pool = [...candidates];
  const stages: Array<[DecisionKind, (c: IPayoutCandidate) => boolean]> = [
    ['worked', c => c.worked_in_month && !firedNoDate.has(c.employee_id)],
    ['earlier', c => earlier.has(c.employee_id)],
  ];
  for (const [kind, keep] of stages) {
    const next = pool.filter(keep);
    if (next.length === 1) return { employeeId: next[0].employee_id, kind };
    if (next.length > 1) pool = next;
  }
  return { employeeId: null, kind: 'ambiguous' };
};
