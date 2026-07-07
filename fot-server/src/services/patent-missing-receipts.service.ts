import { query } from '../config/postgres.js';
import { resolveResponsibleEmployeeIdsByEmployee } from './approval-routing.service.js';

/** Стоимость патента за один месяц (₽). Порог «достаточной» суммы чеков. */
export const MONTHLY_PATENT_AMOUNT = 10000;

/**
 * Корень структуры ООО СУ-10 в org_departments. Отчёт ограничен этим поддеревом —
 * подрядные организации и прочие компании в список не попадают.
 * (Тот же id, что в scripts/export-su10-departments.mjs.)
 */
export const SU10_ROOT_ID = '2cd8a403-6454-408b-9c2b-8a2db65c7511';

/**
 * Префиксы гражданств (UPPER), для которых нужен патент (визово-безвизовые не-ЕАЭС).
 * `МОЛД` покрывает «МОЛДОВА, РЕСПУБЛИКА»/«МОЛДАВИЯ». Граждане РФ/ЕАЭС и визовых стран
 * (Сербия/Турция — там разрешение на работу, не патент) в список не попадают.
 */
export const PATENT_COUNTRY_PREFIXES = ['УЗБЕКИСТАН', 'ТАДЖИКИСТАН', 'УКРАИНА', 'АЗЕРБАЙДЖАН', 'МОЛД', 'ТУРКМЕН'];

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface IMissingPatentRow {
  employee_id: number;
  full_name: string | null;
  position_name: string | null;
  department_name: string | null;
  manager_full_name: string | null;
  objects: string[];
  paid_sum: number;
  required_sum: number;
  months_count: number;
}

/** Число календарных месяцев в диапазоне [from, to] включительно. */
function monthsBetweenInclusive(from: string, to: string): number {
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  return (ty - fy) * 12 + (tm - fm) + 1;
}

interface IRawRow {
  employee_id: number | string;
  full_name: string | null;
  position_name: string | null;
  department_name: string | null;
  org_department_id: string | null;
  paid_sum: string | number | null;
}

/**
 * Список активных сотрудников, у которых были проходы СКУД в периоде, но сумма
 * прикреплённых чеков за патент меньше требуемой (число месяцев × 10000 ₽).
 */
export async function getMissingPatentReceipts(from: string, to: string): Promise<IMissingPatentRow[]> {
  if (!ISO_DATE_RE.test(from) || !ISO_DATE_RE.test(to)) {
    throw new Error('Некорректный формат дат (YYYY-MM-DD)');
  }
  if (from > to) {
    throw new Error('Дата «по» должна быть не раньше даты «с»');
  }

  const monthsCount = Math.max(1, monthsBetweenInclusive(from, to));
  const requiredSum = monthsCount * MONTHLY_PATENT_AMOUNT;

  const rows = await query<IRawRow>(
    `WITH worked AS (
       SELECT DISTINCT ev.employee_id
       FROM skud_events ev
       WHERE ev.employee_id IS NOT NULL
         AND ev.event_date >= $1::date AND ev.event_date <= $2::date
     ),
     paid AS (
       SELECT employee_id,
              COALESCE(SUM(COALESCE(payment_amount, total_amount, 0)), 0) AS paid_sum
       FROM patent_payment_receipts
       WHERE employee_id IS NOT NULL
         AND COALESCE(payment_date, period_start, created_at::date) >= $1::date
         AND COALESCE(payment_date, period_start, created_at::date) <= $2::date
       GROUP BY employee_id
     )
     SELECT e.id AS employee_id,
            e.full_name,
            p.name  AS position_name,
            od.name AS department_name,
            e.org_department_id,
            COALESCE(pd.paid_sum, 0) AS paid_sum
     FROM worked w
     JOIN employees e ON e.id = w.employee_id
     LEFT JOIN positions p ON p.id = e.position_id
     LEFT JOIN org_departments od ON od.id = e.org_department_id
     LEFT JOIN paid pd ON pd.employee_id = e.id
     WHERE e.is_archived = false AND e.employment_status = 'active'
       AND e.org_department_id IN (
         SELECT public.get_descendant_department_ids(ARRAY[$4]::uuid[])
       )
       AND EXISTS (
         SELECT 1 FROM unnest($5::text[]) pfx
         WHERE UPPER(TRIM(e.country)) LIKE pfx || '%'
       )
       AND COALESCE(pd.paid_sum, 0) < $3::numeric
     ORDER BY od.name NULLS LAST, e.full_name`,
    [from, to, requiredSum, SU10_ROOT_ID, PATENT_COUNTRY_PREFIXES],
  );

  // Объекты, где сотрудник работал в периоде: проходы СКУД (access_point → объект)
  // + ручные объектные корректировки. Тот же маппинг, что в fetchEmployeeIdsForObjects.
  const employeeIds = rows.map(r => Number(r.employee_id));
  const objectsMap = new Map<number, string[]>();
  if (employeeIds.length > 0) {
    const objRows = await query<{ employee_id: number | string; objects: string[] | null }>(
      `SELECT employee_id, array_agg(DISTINCT object_name ORDER BY object_name) AS objects
         FROM (
           SELECT se.employee_id, so.name AS object_name
             FROM skud_events se
             JOIN skud_object_access_points sap
               ON BTRIM(lower(sap.access_point_name)) = BTRIM(lower(se.access_point))
             JOIN skud_objects so ON so.id = sap.object_id
            WHERE se.employee_id = ANY($1::bigint[])
              AND se.event_date BETWEEN $2::date AND $3::date
           UNION
           SELECT aa.employee_id,
                  COALESCE(so.name, NULLIF(aa.metadata->>'object_name', '')) AS object_name
             FROM attendance_adjustments aa
             LEFT JOIN skud_objects so ON so.id = NULLIF(aa.metadata->>'object_id', '')::uuid
            WHERE aa.source_type = 'manual_object'
              AND aa.employee_id = ANY($1::bigint[])
              AND aa.work_date BETWEEN $2::date AND $3::date
         ) t
        WHERE object_name IS NOT NULL AND object_name <> ''
        GROUP BY employee_id`,
      [employeeIds, from, to],
    );
    objRows.forEach(o => objectsMap.set(Number(o.employee_id), o.objects ?? []));
  }

  // Руководитель: прямой (employee_direct_reports), иначе начальник участка/отдела
  // (employee_department_access, full-доступ) — тот же приоритет, что в согласованиях.
  const mgrMap = await resolveResponsibleEmployeeIdsByEmployee(
    rows.map(r => ({ employee_id: Number(r.employee_id), org_department_id: r.org_department_id })),
  );
  const mgrIds = [...new Set([...mgrMap.values()].flat())];
  const names = new Map<number, string>();
  if (mgrIds.length > 0) {
    const nameRows = await query<{ id: number; full_name: string | null }>(
      `SELECT id, full_name FROM employees WHERE id = ANY($1::bigint[])`,
      [mgrIds],
    );
    nameRows.forEach(n => names.set(Number(n.id), n.full_name ?? ''));
  }

  return rows.map(r => {
    const managers = (mgrMap.get(Number(r.employee_id)) ?? [])
      .map(id => names.get(id))
      .filter((n): n is string => Boolean(n));
    return {
      employee_id: Number(r.employee_id),
      full_name: r.full_name,
      position_name: r.position_name,
      department_name: r.department_name,
      manager_full_name: managers.length > 0 ? managers.join(', ') : null,
      objects: objectsMap.get(Number(r.employee_id)) ?? [],
      paid_sum: Number(r.paid_sum) || 0,
      required_sum: requiredSum,
      months_count: monthsCount,
    };
  });
}

export interface ISu10Department {
  id: string;
  name: string;
}

/** Активные узлы (бригады/отделы) в составе ООО СУ-10 — для фильтра «Бригада/отдел». */
export async function getSu10Departments(): Promise<ISu10Department[]> {
  return query<ISu10Department>(
    `SELECT od.id, od.name
       FROM org_departments od
      WHERE od.is_active = true
        AND od.id <> $1::uuid
        AND od.id IN (SELECT public.get_descendant_department_ids(ARRAY[$1]::uuid[]))
      ORDER BY od.name`,
    [SU10_ROOT_ID],
  );
}
