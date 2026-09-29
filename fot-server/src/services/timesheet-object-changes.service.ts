/**
 * Столбец «Изменения объекта табелирования» единого файла 1С: кто вручную поставил
 * объект, действующий в месяце выгрузки, и когда (миграция 289).
 *
 *   «Сам сотрудник, 29.09.2026»             — выбор в ЛК;
 *   «Руководитель Боюкян М. В., 29.09.2026» — тот, кто ведёт табель;
 *   «Админ Есенов Максим АДМ, 29.09.2026»   — админ в табеле или окно «Режим
 *                                             табелирования» (там правят и кадры).
 *
 * Автор хранится рядом с личным режимом, для прошедшего месяца — в его фиксации.
 * Запись режима не человеком (скрипт, миграция, ночной расчёт) автора стирает, поэтому
 * такие объекты, «По СКУД» и объект от отдела остаются без подписи. ФИО и роль автора —
 * текущие: после удаления учётки остаются только «кто» и дата.
 */
import { query, type DbExecutor } from '../config/postgres.js';
import { moscowTodayIso } from '../utils/date.utils.js';
import { formatNameWithInitials } from '../utils/fio.utils.js';
import {
  FROZEN_PERSONAL_MODE_SQL,
  FROZEN_PERSONAL_SET_BY_SQL,
  currentMonthStartMsk,
  freezeMonthCte,
  toMonthStart,
} from './timesheet-export-mode.service.js';

export interface IObjectChangeRow {
  employee_id: number | string;
  /** Прошедший месяц, а строки фиксации нет — автора месяца не знаем. */
  freeze_missing: boolean | null;
  mode: string | null;
  set_by: string | null;
  set_at: Date | string | null;
  author_profile_name: string | null;
  author_employee_name: string | null;
  author_is_admin: boolean | null;
}

// Режим, источник и автор — живые или из фиксации, по тем же правилам, что у адреса.
// Функция, а не константа модуля: тесты с моком timesheet-export-mode без этих фрагментов
// грузят модуль по цепочке импортов.
const objectChangesSql = (): string => `
  WITH ${freezeMonthCte('$2', '$3')}
  SELECT e.id                                              AS employee_id,
         (fm.month IS NOT NULL AND f.employee_id IS NULL)  AS freeze_missing,
         ${FROZEN_PERSONAL_MODE_SQL}                       AS mode,
         ${FROZEN_PERSONAL_SET_BY_SQL}                     AS set_by,
         author.set_at,
         up.full_name                                      AS author_profile_name,
         ae.full_name                                      AS author_employee_name,
         sr.is_admin                                       AS author_is_admin
    FROM employees e
   CROSS JOIN fm
    LEFT JOIN employee_timesheet_object_months f
           ON f.employee_id = e.id AND f.month = fm.month
   CROSS JOIN LATERAL (
     SELECT CASE WHEN f.employee_id IS NOT NULL THEN f.set_by_user_id
                 ELSE e.timesheet_export_set_by_user_id END AS user_id,
            CASE WHEN f.employee_id IS NOT NULL THEN f.set_at
                 ELSE e.timesheet_export_set_at END         AS set_at
   ) AS author
    LEFT JOIN user_profiles up ON up.id = author.user_id
    LEFT JOIN employees ae     ON ae.id = up.employee_id
    LEFT JOIN system_roles sr  ON sr.id = up.system_role_id
   WHERE e.id = ANY($1::int[])`;

/** 'дд.мм.гггг' по МСК. */
const formatMskDate = (date: Date): string => {
  const [year, month, day] = moscowTodayIso(date).split('-');
  return `${day}.${month}.${year}`;
};

// Учётка сотрудника — «Фамилия И. О.»; служебная (админ без сотрудника) — как в профиле.
const authorName = (row: IObjectChangeRow): string => {
  const employeeName = row.author_employee_name?.trim();
  if (employeeName) return formatNameWithInitials(employeeName);
  return row.author_profile_name?.trim() ?? '';
};

/** Подпись строки; null — объект поставил не человек или объекта нет. */
export function buildObjectChangeLabel(row: IObjectChangeRow): string | null {
  if (row.freeze_missing) return null;
  if (row.mode !== 'object' && row.mode !== 'current_activity') return null;
  if (row.set_by === 'auto' || !row.set_at) return null;
  const setAt = row.set_at instanceof Date ? row.set_at : new Date(row.set_at);
  if (Number.isNaN(setAt.getTime())) return null;

  const date = formatMskDate(setAt);
  if (row.set_by === 'employee') return `Сам сотрудник, ${date}`;
  // set_by = 'manager' — путь табеля, им пользуется и админ; NULL — окно «Режим табелирования».
  const who = row.set_by === 'manager' && row.author_is_admin !== true ? 'Руководитель' : 'Админ';
  const name = authorName(row);
  return name ? `${who} ${name}, ${date}` : `${who}, ${date}`;
}

/**
 * Подписи по сотрудникам за месяц выгрузки (month — любой день месяца; null — живое
 * значение). exec — клиент снимка, в котором читаются и режимы строк: иначе ручная смена
 * между двумя запросами дала бы адрес одного объекта и подпись другого.
 */
export async function loadTimesheetObjectChanges(
  employeeIds: number[],
  month: string | null,
  options: { now?: Date; exec?: DbExecutor } = {},
): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  const ids = [...new Set(employeeIds.filter(id => Number.isInteger(id) && id > 0))];
  if (ids.length === 0) return result;

  const sql = objectChangesSql();
  const params = [ids, toMonthStart(month), currentMonthStartMsk(options.now ?? new Date())];
  const rows = options.exec
    ? (await options.exec.query<IObjectChangeRow>(sql, params)).rows
    : await query<IObjectChangeRow>(sql, params);
  for (const row of rows) {
    const label = buildObjectChangeLabel(row);
    if (label) result.set(Number(row.employee_id), label);
  }
  return result;
}
