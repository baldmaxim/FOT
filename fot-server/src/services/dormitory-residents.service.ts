/**
 * Сведения о жильцах для вкладок «Проживания» (миграция 371) — пачкой по id сотрудников, только тем, кого вызывающий
 * уже отобрал по охвату кадров:
 * - «Паспорт» — полный номер тому, кто правит «Реквизиты» (и админу, как в карточке), остальным — последние 4 знака:
 *   расшифровка и маска на сервере, полный номер без права в ответ не уходит; нет реквизитов — null;
 * - «Крайний проход» — последнее событие СКУД (вход/выход) за 60 дней: время МСК и точка прохода как есть
 *   («Дом-56 КПП»), без перевода в объект;
 * - «Начальник участка» — правило столбца «Участок» «Управления кадрами» (staffSiteLabel), иначе руководители
 *   отдела карточки; «Фамилия И. О.», несколько — по алфавиту через запятую;
 * - телефон (реквизиты, не маскируется — как в карточке) и текущий или ближайший согласованный отпуск.
 */
import { query } from '../config/postgres.js';
import { formatNameWithInitials } from '../utils/fio.utils.js';
import { listDepartmentManagers } from './department-managers.service.js';
import { decryptFieldSafe, maskValue } from './hr-crypto.service.js';
import { loadStaffSiteIndex, staffSiteLabel } from './staff-site.service.js';

/** Сколько дней назад искать крайний проход (граница event_date — секции skud_events отсекаются). */
export const LAST_PASS_LOOKBACK_DAYS = 60;

export interface IResidentLastPass {
  /** YYYY-MM-DDTHH:MM:SS по Москве. */
  at: string;
  access_point: string | null;
}

export interface IResidentVacation {
  /** YYYY-MM-DD. */
  from: string;
  to: string;
}

const uniqueIds = (ids: readonly number[]): number[] => [...new Set(ids.filter(id => Number.isInteger(id) && id > 0))];

/** Паспорт: full — полный номер (право правки «Реквизитов» или «Проживания»), иначе последние 4 знака (••••••3158). */
export const loadPassports = async (
  employeeIds: readonly number[],
  { full }: { full: boolean },
): Promise<Map<number, string>> => {
  const ids = uniqueIds(employeeIds);
  const result = new Map<number, string>();
  if (ids.length === 0) return result;
  const rows = await query<{ employee_id: number; passport_number_enc: string | null }>(
    `SELECT employee_id, passport_number_enc FROM employee_hr_profiles
      WHERE employee_id = ANY($1::int[]) AND passport_number_enc IS NOT NULL`,
    [ids],
  );
  for (const row of rows) {
    const plain = decryptFieldSafe(row.passport_number_enc);
    const value = full ? plain?.trim() || null : maskValue(plain, 4);
    if (value) result.set(Number(row.employee_id), value);
  }
  return result;
};

/**
 * Крайний проход сотрудника за LAST_PASS_LOOKBACK_DAYS дней до today включительно: самое позднее событие входа
 * или выхода (при равном времени — больший id).
 */
export const loadLastPasses = async (
  employeeIds: readonly number[],
  today: string,
): Promise<Map<number, IResidentLastPass>> => {
  const ids = uniqueIds(employeeIds);
  const result = new Map<number, IResidentLastPass>();
  if (ids.length === 0) return result;
  const rows = await query<{ employee_id: number; at: string; access_point: string | null }>(
    `SELECT x.id AS employee_id,
            to_char(le.event_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD"T"HH24:MI:SS') AS at,
            le.access_point
       FROM unnest($1::int[]) AS x(id)
       JOIN LATERAL (
         SELECT se.event_at, se.access_point
           FROM skud_events se
          WHERE se.employee_id = x.id
            AND se.event_date >= $2::date - $3::int
            AND se.event_date <= $2::date
            AND se.direction IN ('entry', 'exit')
          ORDER BY se.event_at DESC, se.id DESC
          LIMIT 1
       ) le ON true`,
    [ids, today, LAST_PASS_LOOKBACK_DAYS],
  );
  for (const row of rows) {
    result.set(Number(row.employee_id), { at: row.at, access_point: row.access_point?.trim() || null });
  }
  return result;
};

/**
 * «Начальник участка»: начальники участка по правилу «Управления кадрами» (личное назначение, иначе отдел), а если
 * их нет — руководители отдела карточки. Нет никого — сотрудника нет в ответе.
 */
export const loadSupervisorLabels = async (
  employees: ReadonlyArray<{ employee_id: number; org_department_id: string | null }>,
): Promise<Map<number, string>> => {
  const result = new Map<number, string>();
  if (employees.length === 0) return result;
  const index = await loadStaffSiteIndex();
  const withoutSite: Array<{ employee_id: number; org_department_id: string }> = [];
  for (const employee of employees) {
    const label = staffSiteLabel(index, employee.employee_id, employee.org_department_id);
    if (label) result.set(employee.employee_id, label);
    else if (employee.org_department_id) withoutSite.push({ ...employee, org_department_id: employee.org_department_id });
  }
  if (withoutSite.length === 0) return result;

  const managers = await listDepartmentManagers(withoutSite.map(employee => employee.org_department_id));
  const managerIds = uniqueIds([...managers.values()].flat());
  if (managerIds.length === 0) return result;
  const names = new Map(
    (await query<{ id: number; full_name: string | null }>(
      `SELECT id, full_name FROM employees WHERE id = ANY($1::int[])`,
      [managerIds],
    )).map(row => [Number(row.id), formatNameWithInitials(String(row.full_name ?? ''))]),
  );
  for (const employee of withoutSite) {
    const labels = (managers.get(employee.org_department_id) ?? [])
      .map(id => names.get(id) ?? '')
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b, 'ru'));
    const unique = [...new Set(labels)];
    if (unique.length > 0) result.set(employee.employee_id, unique.join(', '));
  }
  return result;
};

/** Телефон из реквизитов (как в карточке, без маски); пустой — нет в ответе. */
export const loadPhones = async (employeeIds: readonly number[]): Promise<Map<number, string>> => {
  const ids = uniqueIds(employeeIds);
  const result = new Map<number, string>();
  if (ids.length === 0) return result;
  const rows = await query<{ employee_id: number; phone: string | null }>(
    `SELECT employee_id, phone FROM employee_hr_profiles
      WHERE employee_id = ANY($1::int[]) AND NULLIF(btrim(phone), '') IS NOT NULL`,
    [ids],
  );
  for (const row of rows) if (row.phone) result.set(Number(row.employee_id), row.phone.trim());
  return result;
};

/** Текущий или ближайший согласованный ежегодный отпуск (заявление vacation, approved) с окончанием не раньше today. */
export const loadNearestVacations = async (
  employeeIds: readonly number[],
  today: string,
): Promise<Map<number, IResidentVacation>> => {
  const ids = uniqueIds(employeeIds);
  const result = new Map<number, IResidentVacation>();
  if (ids.length === 0) return result;
  const rows = await query<{ employee_id: number; from: string; to: string }>(
    `SELECT DISTINCT ON (lr.employee_id) lr.employee_id,
            to_char(lr.start_date, 'YYYY-MM-DD') AS "from",
            to_char(lr.end_date, 'YYYY-MM-DD') AS "to"
       FROM leave_requests lr
      WHERE lr.employee_id = ANY($1::int[])
        AND lr.request_type = 'vacation'
        AND lr.status = 'approved'
        AND lr.end_date >= $2::date
      ORDER BY lr.employee_id, lr.start_date, lr.id`,
    [ids, today],
  );
  for (const row of rows) result.set(Number(row.employee_id), { from: row.from, to: row.to });
  return result;
};
