/**
 * Зарплата своих сотрудников в табеле (миграция 382): галочка «Видеть зарплату своих сотрудников в табеле» во вкладке
 * «Выработка» назначений. Руководитель видит столбец «Зарплата» (к выплате за прошлый месяц) по отделам, где у него
 * ручная full-привязка (не sigur_sync), вместе с подотделами. Начальник участка — по своим бригадам: это такие же
 * full-привязки. Заместители (deputy) и «Мои сотрудники» в охват не входят.
 *
 * Охват — по управлению, а не по читаемости табеля: роль hr, «Просмотр всех табелей», «Просмотр табеля» (309) и
 * view-привязки денег не открывают. Отдельный гард, а не ключ страницы: resolveEffectivePageAccess пропускает
 * is_admin, и новый ключ открыл бы зарплаты всем админам.
 */
import type { PoolClient } from 'pg';

import { query, queryOne } from '../../config/postgres.js';
import type { AuthenticatedRequest } from '../../types/index.js';
import { moscowTodayIso } from '../../utils/date.utils.js';
import { listEditableDepartmentIdsForUser } from '../department-access.service.js';

/**
 * Есть ли у сотрудника галочка. Предикат зовут гард и /auth/me, поэтому недоступная база (в том числе таблица до
 * миграции 382) означает «нет доступа» — fail-closed, а не 500.
 */
export async function hasTeamSalaryGrant(employeeId: number | null | undefined): Promise<boolean> {
  if (!employeeId) return false;
  try {
    const rows = await query<{ employee_id: number | string }>(
      'SELECT employee_id FROM employee_team_salary_access WHERE employee_id = $1',
      [employeeId],
    );
    return rows.length > 0;
  } catch (err) {
    console.warn('[team-salary-access] grant check failed:', err instanceof Error ? err.message : err);
    return false;
  }
}

/** Отделы-корни руководителя: ручные full-привязки (без sigur_sync — это членство, а не управление). */
export async function listTeamSalaryRootDepartmentIds(employeeId: number): Promise<string[]> {
  return listEditableDepartmentIdsForUser('', employeeId);
}

/** Корни вместе с подотделами (get_descendant_department_ids включает и сами корни). */
export async function expandTeamSalaryDepartmentIds(rootIds: readonly string[]): Promise<string[]> {
  if (rootIds.length === 0) return [];
  const rows = await query<{ id: string }>(
    'SELECT id FROM public.get_descendant_department_ids($1::uuid[])',
    [[...rootIds]],
  );
  return [...new Set(rows.map(row => row.id))];
}

/**
 * Охват зарплат сотрудника: галочка ∧ отделы руководителя с подотделами. Нет галочки, нет отделов или ошибка базы —
 * [] (fail-closed: функцию зовут гард и /auth/me).
 */
export async function resolveTeamSalaryDepartmentIds(employeeId: number | null | undefined): Promise<string[]> {
  if (!employeeId) return [];
  try {
    if (!(await hasTeamSalaryGrant(employeeId))) return [];
    return await expandTeamSalaryDepartmentIds(await listTeamSalaryRootDepartmentIds(employeeId));
  } catch (err) {
    console.warn('[team-salary-access] scope check failed:', err instanceof Error ? err.message : err);
    return [];
  }
}

/** Охват текущего пользователя с кэшем на время HTTP-запроса: его читают гард и контроллер. */
export async function getRequestTeamSalaryDepartmentIds(req: AuthenticatedRequest): Promise<string[]> {
  if (req.user.__team_salary_department_ids !== undefined) return req.user.__team_salary_department_ids;
  const ids = await resolveTeamSalaryDepartmentIds(req.user.employee_id);
  req.user.__team_salary_department_ids = ids;
  return ids;
}

/** Галочка для панели назначений: ошибка базы пробрасывается, а не подменяется «нет». */
export async function loadTeamSalaryGrant(employeeId: number): Promise<boolean> {
  const row = await queryOne<{ employee_id: number | string }>(
    'SELECT employee_id FROM employee_team_salary_access WHERE employee_id = $1',
    [employeeId],
  );
  return row !== null;
}

/** Названия отделов-корней руководителя — для панели назначений (выдающий видит, к чему откроет доступ). */
export async function listTeamSalaryRootDepartmentNames(employeeId: number): Promise<string[]> {
  const ids = await listTeamSalaryRootDepartmentIds(employeeId);
  if (ids.length === 0) return [];
  const rows = await query<{ name: string | null }>(
    'SELECT name FROM org_departments WHERE id = ANY($1::uuid[]) ORDER BY name',
    [ids],
  );
  return rows.map(row => row.name ?? 'Без названия');
}

/** Поставить или снять галочку в транзакции вызывающего; true — что-то изменилось. */
export async function setTeamSalaryGrant(
  client: PoolClient,
  employeeId: number,
  granted: boolean,
  createdBy: string | null,
): Promise<boolean> {
  const result = granted
    ? await client.query(
      `INSERT INTO employee_team_salary_access (employee_id, created_by)
       VALUES ($1, $2)
       ON CONFLICT (employee_id) DO NOTHING
       RETURNING employee_id`,
      [employeeId, createdBy],
    )
    : await client.query(
      'DELETE FROM employee_team_salary_access WHERE employee_id = $1 RETURNING employee_id',
      [employeeId],
    );
  return result.rows.length > 0;
}

/** Первый день, с которого виден месяц зарплаты: 10-е число следующего месяца (решение пользователя 27.11.2026). */
export const TEAM_SALARY_RELEASE_DAY = 10;

const pad2 = (value: number): string => String(value).padStart(2, '0');

/** Сдвиг месяца YYYY-MM на delta (через год — тоже). */
const shiftMonth = (year: number, month: number, delta: number): { year: number; month: number } => {
  const index = year * 12 + (month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
};

/** Момент 00:00 МСК 10-го числа месяца (МСК = UTC+3 без перехода на летнее время) — ISO в UTC. */
const releaseInstant = (year: number, month: number): string => (
  new Date(`${year}-${pad2(month)}-${pad2(TEAM_SALARY_RELEASE_DAY)}T00:00:00+03:00`).toISOString()
);

export interface IReleasedSalaryMonth {
  /** Месяц столбца, YYYY-MM. */
  month: string;
  /** Когда столбец перейдёт на следующий месяц — 00:00 МСК 10-го числа, ISO в UTC. */
  next_from: string;
}

/**
 * Месяц столбца «Зарплата» — всегда прошлый, на любом месяце сетки. Дата — по МСК (прод в UTC):
 * день < 10 → месяц−2, смена — 10-го текущего; день ≥ 10 → месяц−1, смена — 10-го следующего.
 */
export const resolveReleasedSalaryMonth = (now: Date = new Date()): IReleasedSalaryMonth => {
  const today = moscowTodayIso(now);
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const day = Number(today.slice(8, 10));
  const released = day >= TEAM_SALARY_RELEASE_DAY;
  const shown = shiftMonth(year, month, released ? -1 : -2);
  const next = released ? shiftMonth(year, month, 1) : { year, month };
  return {
    month: `${shown.year}-${pad2(shown.month)}`,
    next_from: releaseInstant(next.year, next.month),
  };
};
