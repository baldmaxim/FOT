/**
 * Сотрудник строки ведомости из API (миграция 379):
 *  1. ID_FOT, присланный 1С (справочник GET /employees), — главный ключ. Нет такой карточки или она в месяце у
 *     подрядчика — «без сотрудника» с причиной; ФИО и код физлица тогда не подбираются.
 *  2. Без ID_FOT — как генераторы: код физлица 1С (id_all), затем ФИО (один кандидат, тёзка — работал в месяце, тёзка —
 *     подтверждён ранее), иначе «без сотрудника» (decide, payroll-1c-payouts.person-decision.ts).
 * ID_FOT и код физлица ведут к разным сотрудникам — берётся ID_FOT, в ответ 1С — предупреждение.
 */
import { query } from '../../config/postgres.js';
import { loadPayoutEligibility, matchPayoutLines, SQL_NAME } from './payroll-1c-payouts.matching.js';
import type { IPayoutApiDocument } from './payroll-1c-payouts.month-xml.js';
import { normalizePayoutName } from './payroll-1c-payouts.parser.js';
import { decide, decisionLabel } from './payroll-1c-payouts.person-decision.js';
import type { PayoutResolution } from './payroll-1c-payouts.service.js';

export interface IPayoutApiLineTarget {
  lineKey: string;
  employeeId: number | null;
  resolution: PayoutResolution;
  reason: string;
  warning: string | null;
}

/** Сотрудники строк одной ведомости (месяц — её ПериодРегистрации). Только чтение. */
export const resolvePayoutApiLines = async (doc: IPayoutApiDocument): Promise<IPayoutApiLineTarget[]> => {
  const idFots = [...new Set(doc.lines.map(line => line.idFot).filter((id): id is number => id !== null))];
  const names = [...new Set(doc.lines.map(line => normalizePayoutName(line.fullName)))];
  const [matches, byIdFot, earlierRows] = await Promise.all([
    matchPayoutLines({ lines: doc.lines, periodMonth: doc.periodMonth }),
    loadPayoutEligibility(idFots, doc.periodMonth),
    query<{ name_key: string; employee_id: number }>(
      `SELECT DISTINCT ${SQL_NAME('l.full_name_1c')} AS name_key, l.employee_id FROM payroll_1c_payout_lines l
        WHERE l.employee_id IS NOT NULL AND l.resolution IN ('auto_id_fot', 'auto_id_all', 'confirmed')
          AND ${SQL_NAME('l.full_name_1c')} = ANY($1::text[])`,
      [names],
    ),
  ]);
  const earlierByName = new Map<string, Set<number>>();
  for (const row of earlierRows) {
    earlierByName.set(row.name_key, new Set([...(earlierByName.get(row.name_key) ?? []), Number(row.employee_id)]));
  }
  // Уволенный без даты увольнения (старые карточки) «работал в любом месяце» — для тёзок это не так.
  const candidateIds = [...new Set([...matches.values()].flatMap(match => match.candidates.map(candidate => candidate.employee_id)))];
  const firedNoDate = new Set(candidateIds.length === 0 ? [] : (await query<{ id: number }>(
    `SELECT id FROM employees WHERE id = ANY($1::int[]) AND employment_status = 'fired' AND dismissal_date IS NULL`,
    [candidateIds],
  )).map(row => Number(row.id)));

  return doc.lines.map((line): IPayoutApiLineTarget => {
    const match = matches.get(line.lineKey) ?? { auto_employee_id: null, candidates: [] };
    if (line.idFot !== null) {
      const info = byIdFot.get(line.idFot);
      if (!info) {
        return { lineKey: line.lineKey, employeeId: null, resolution: 'unmatched', reason: `API 1С: ID_FOT ${line.idFot} — нет в ФОТ`, warning: null };
      }
      if (!info.eligible) {
        return {
          lineKey: line.lineKey, employeeId: null, resolution: 'unmatched',
          reason: `API 1С: ID_FOT ${line.idFot} — в месяце у подрядчика`, warning: null,
        };
      }
      const other = match.auto_employee_id;
      return {
        lineKey: line.lineKey,
        employeeId: line.idFot,
        resolution: 'auto_id_fot',
        reason: 'API 1С: по ID_FOT',
        warning: other !== null && other !== line.idFot
          ? `${line.fullName}: код физлица 1С ведёт к сотруднику ${other}, ID_FOT — ${line.idFot}; взят ID_FOT`
          : null,
      };
    }
    const decision = decide(
      match.candidates, match.auto_employee_id, earlierByName.get(normalizePayoutName(line.fullName)) ?? new Set(), firedNoDate,
    );
    const reason = `API 1С: ${decisionLabel(decision.kind)}`;
    if (decision.employeeId === null) return { lineKey: line.lineKey, employeeId: null, resolution: 'unmatched', reason, warning: null };
    return {
      lineKey: line.lineKey,
      employeeId: decision.employeeId,
      resolution: decision.kind === 'id_all' ? 'auto_id_all' : 'confirmed',
      reason,
      warning: null,
    };
  });
};
