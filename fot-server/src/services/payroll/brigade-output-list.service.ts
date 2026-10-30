/**
 * Список вкладки «Табель → Бригады» (341): бригады месяца и внесённая выработка — сумма бригаде или по объектам.
 *
 * Бригады с людьми в месяце — те же три источника, что у состава бригады (listEmployeeMembershipsForDepartmentPeriod):
 * назначения, пересекающие месяц, текущий отдел и отдел увольнения в месяце, с тем же отсевом архива и уволенных
 * (firedPortalEligibleSql). Без выбора одного отдела на человека: переведённый в месяце виден в обеих бригадах —
 * список шире состава (начальник участка, исключённый из табеля), но бригада с людьми не пропадает. Плюс бригады с
 * внесённой выработкой месяца — в том числе неактивные, чтобы её можно было увидеть и стереть.
 *
 * Долей здесь не считаем — два запроса на весь список; объекты бригады грузит раскрытие строки.
 */
import { query } from '../../config/postgres.js';
import { firedPortalEligibleSql } from '../timesheet-fired-cutoff.service.js';
import { monthBounds } from './brigade-salary-source.service.js';

export interface IBrigadeOutputListItem {
  department_id: string;
  name: string;
  is_active: boolean;
  /** Сумма бригаде (341); null — не внесена. */
  brigade_output: string | null;
  /** Σ выработки по объектам; null — не внесена ни на одном. */
  objects_output: string | null;
  /** Сколько объектов с внесённой выработкой. */
  objects_with_output: number;
}

/** readable — видимые отделы «Зарплаты» ('all' — весь штат). */
export async function listBrigadeOutputs(
  month: string,
  readable: 'all' | readonly string[],
): Promise<IBrigadeOutputListItem[]> {
  if (readable !== 'all' && readable.length === 0) return [];
  const { start, end } = monthBounds(month);
  const rows = await query<{
    department_id: string;
    name: string;
    is_active: boolean;
    brigade_output: string | null;
    objects_output: string | null;
    objects_with_output: string | number;
  }>(
    `WITH people AS (
       SELECT a.org_department_id AS department_id
         FROM employee_assignments a
         JOIN employees e ON e.id = a.employee_id
        WHERE a.effective_from <= $2::date
          AND (a.effective_to IS NULL OR a.effective_to >= $1::date)
          AND e.is_archived = false AND ${firedPortalEligibleSql('e', '$1')}
       UNION
       SELECT e.org_department_id
         FROM employees e
        WHERE e.org_department_id IS NOT NULL
          AND e.is_archived = false AND ${firedPortalEligibleSql('e', '$1')}
       UNION
       SELECT de.from_department_id
         FROM employee_dismissal_events de
         JOIN employees e ON e.id = de.employee_id
        WHERE de.dismissal_date IS NOT NULL
          AND de.dismissal_date >= $1::date
          AND de.cancelled = false
          AND e.is_archived = false AND ${firedPortalEligibleSql('e', '$1')}
     ),
     objects AS (
       SELECT department_id, SUM(amount) AS total, count(*) AS cnt
         FROM brigade_salary_object_outputs
        WHERE month = $1::date
        GROUP BY department_id
     )
     SELECT d.id::text AS department_id, d.name, COALESCE(d.is_active, true) AS is_active,
            bo.amount::text AS brigade_output, o.total::text AS objects_output, COALESCE(o.cnt, 0) AS objects_with_output
       FROM org_departments d
       LEFT JOIN brigade_salary_brigade_outputs bo ON bo.department_id = d.id AND bo.month = $1::date
       LEFT JOIN objects o ON o.department_id = d.id
      WHERE d.kind = 'brigade'
        AND ($3::uuid[] IS NULL OR d.id = ANY($3::uuid[]))
        AND (
          bo.department_id IS NOT NULL
          OR o.department_id IS NOT NULL
          OR (COALESCE(d.is_active, true) AND EXISTS (SELECT 1 FROM people p WHERE p.department_id = d.id))
        )
      ORDER BY d.name, d.id`,
    [start, end, readable === 'all' ? null : [...readable]],
  );
  return rows.map(row => ({
    department_id: row.department_id,
    name: row.name,
    is_active: row.is_active === true,
    brigade_output: row.brigade_output,
    objects_output: row.objects_output,
    objects_with_output: Number(row.objects_with_output),
  }));
}
