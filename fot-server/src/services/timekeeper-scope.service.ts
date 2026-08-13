import type { AuthenticatedRequest } from '../types/index.js';
import { query } from '../config/postgres.js';

/**
 * Скоуп роли «Табельщица» (timekeeper).
 *
 * Табельщице назначаются «объекты входа» (timekeeper_object_access) и «папки»
 * оргструктуры (timekeeper_folder_access). Её «явные отделы» (seeds скоупа) =
 * ПЕРЕСЕЧЕНИЕ: бригады и листовые отделы, где есть работники с её объектов
 * (employee_skud_object_access), И входящие в поддерево выбранных папок. Эти отделы
 * питают resolveAccessibleDepartmentIds, managed_department_ids и «назначенный режим»
 * (collectAssignedEmployees → начальники участка).
 * См. loadTimekeeperScopeSnapshot. Папки не выбраны → seeds пусто (строго).
 */

export const TIMEKEEPER_ROLE_CODE = 'timekeeper';

/**
 * Окно (в днях) для ветки «присутствие по фактическим проходам СКУД».
 * Отдел/сотрудник считаются присутствующими на объекте табельщицы, если за
 * последние N дней были проходы через проходные этого объекта. Согласовано с
 * прецедентом listSelectableObjectsForEmployee (employee-skud-object-access.service.ts).
 */
export const TIMEKEEPER_PRESENCE_WINDOW_DAYS = 90;

export const LI_OBSHESTROY_DEPARTMENT_ID = '0b24809e-5f04-45e1-bbe2-8a82990d6bdd'; // «ЛИНИЯ-Общестрой»

export function isTimekeeper(req: AuthenticatedRequest): boolean {
  return req.user.role_code === TIMEKEEPER_ROLE_CODE;
}

/** Объекты, назначенные табельщице. */
export async function resolveTimekeeperObjectIds(timekeeperUserId: string): Promise<string[]> {
  const rows = await query<{ skud_object_id: string }>(
    `SELECT skud_object_id
       FROM timekeeper_object_access
      WHERE timekeeper_user_id = $1::uuid AND is_active = true`,
    [timekeeperUserId],
  );
  return [...new Set(rows.map(r => r.skud_object_id))];
}

/** Оба множества скоупа табельщицы, полученные из ОДНОГО снимка БД. */
export interface ITimekeeperScopeSnapshot {
  /** Видимые отделы (seeds скоупа). Папки не выбраны → пусто. */
  departmentSeeds: string[];
  /** «Прямые подчинённые» — сотрудники её объектов из трёх источников. */
  directEmployeeIds: number[];
}

/**
 * Один statement на оба множества — вместо двух независимых 90-дневных сканов
 * skud_events, которые раньше выполнялись на каждый запрос табельщицы (а в профиле
 * дважды подряд) и держали соединение по 12–15 секунд.
 *
 * Порядок операций, убирающий раздувание: события за окно сворачиваются до
 * DISTINCT employee_id ДО соединения с employee_department_access. Раньше join с eda
 * шёл по всем 1.3 млн событий и раздувал промежуточный результат до ~1 млн строк
 * ради 72 итоговых отделов.
 *
 * Результат обязан совпадать со старой парой запросов бит-в-бит:
 *   - три источника сотрудников не перепутаны: seeds считаются от (проходы ∪ ручная
 *     привязка), direct — от (проходы ∪ ручная привязка ∪ явное назначение);
 *   - BTRIM с обеих сторон сохранён (на маленькой стороне свёрнут в points);
 *   - окно TIMEKEEPER_PRESENCE_WINDOW_DAYS не изменено;
 *   - предикат допустимых отделов перенесён дословно: у kind='brigade' проверки
 *     is_active НЕТ, она применяется только к ветке kind='department';
 *   - гард «папки не выбраны → seeds пусто» сохранён: array_agg по пустой выборке даёт
 *     NULL → COALESCE в '{}' → get_descendant_department_ids возвращает 0 строк.
 *     Гард касается ТОЛЬКО seeds; direct от папок не зависит.
 *
 * MATERIALIZED обязателен: с PG12+ CTE инлайнятся по умолчанию, и планировщик может
 * размножить скан событий обратно — ровно то, от чего уходим.
 */
export const TIMEKEEPER_SCOPE_SNAPSHOT_SQL = `WITH points AS MATERIALIZED (
       SELECT DISTINCT BTRIM(sap.access_point_name) AS name
         FROM timekeeper_object_access toa
         JOIN skud_object_access_points sap ON sap.object_id = toa.skud_object_id
        WHERE toa.timekeeper_user_id = $1::uuid AND toa.is_active = true
     ),
     event_emp AS MATERIALIZED (
       -- единственный скан событий за окно
       SELECT DISTINCT se.employee_id
         FROM skud_events se
        WHERE se.event_date >= (CURRENT_DATE - INTERVAL '${TIMEKEEPER_PRESENCE_WINDOW_DAYS} days')
          AND BTRIM(se.access_point) IN (SELECT name FROM points)
     ),
     manual_emp AS (
       -- ручная привязка «место работы»
       SELECT esoa.employee_id
         FROM timekeeper_object_access toa
         JOIN employee_skud_object_access esoa
           ON esoa.skud_object_id = toa.skud_object_id AND esoa.is_active = true
        WHERE toa.timekeeper_user_id = $1::uuid AND toa.is_active = true
     ),
     assigned_emp AS (
       -- явное назначение сотрудника на объект (только для direct, не для seeds)
       SELECT eoa.employee_id
         FROM timekeeper_object_access toa
         JOIN employee_object_assignment eoa
           ON eoa.skud_object_id = toa.skud_object_id AND eoa.is_active = true
        WHERE toa.timekeeper_user_id = $1::uuid AND toa.is_active = true
     ),
     present AS MATERIALIZED (
       SELECT employee_id FROM event_emp
       UNION
       SELECT employee_id FROM manual_emp
     ),
     direct AS (
       SELECT employee_id FROM present
       UNION
       SELECT employee_id FROM assigned_emp
     ),
     folder_desc AS (
       SELECT id FROM public.get_descendant_department_ids(
         (SELECT COALESCE(array_agg(department_id), '{}'::uuid[])
            FROM timekeeper_folder_access
           WHERE timekeeper_user_id = $1::uuid AND is_active = true))
     ),
     seeds AS (
       SELECT DISTINCT eda.department_id AS id
         FROM present p
         JOIN employee_department_access eda
           ON eda.employee_id = p.employee_id AND eda.is_active = true
         JOIN org_departments d ON d.id = eda.department_id
        WHERE eda.department_id IN (SELECT id FROM folder_desc)
          AND (
            d.kind = 'brigade'
            OR (
              d.kind = 'department'
              AND d.is_active = true
              AND d.id <> $2::uuid
              AND NOT EXISTS (
                SELECT 1 FROM org_departments c
                 WHERE c.parent_id = d.id AND c.is_active = true
              )
            )
          )
     )
     SELECT 'seed'::text AS kind, id::text          AS val FROM seeds
     UNION ALL
     SELECT 'direct'::text,       employee_id::text AS val FROM direct`;

/** Строка объединённого statement'а. */
export interface ITimekeeperScopeRow {
  kind: string;
  val: string | null;
}

/**
 * Разбор строк объединённого statement'а на два множества.
 * Вынесен отдельно, чтобы скрипт сверки (ворота A) использовал ровно тот же разбор,
 * что и рантайм, — иначе «эквивалентность» доказывалась бы копией кода, а не кодом.
 */
export function parseTimekeeperScopeRows(rows: ITimekeeperScopeRow[]): ITimekeeperScopeSnapshot {
  const seeds: string[] = [];
  const direct: number[] = [];
  for (const row of rows) {
    if (row.kind === 'seed') {
      if (row.val) seeds.push(row.val);
    } else {
      // Приведение и фильтр — как в прежнем listTimekeeperDirectEmployeeIds.
      const id = Number(row.val);
      if (Number.isInteger(id)) direct.push(id);
    }
  }
  return {
    departmentSeeds: [...new Set(seeds)],
    directEmployeeIds: [...new Set(direct)],
  };
}

export async function loadTimekeeperScopeSnapshot(
  timekeeperUserId: string,
): Promise<ITimekeeperScopeSnapshot> {
  const rows = await query<ITimekeeperScopeRow>(
    TIMEKEEPER_SCOPE_SNAPSHOT_SQL,
    [timekeeperUserId, LI_OBSHESTROY_DEPARTMENT_ID],
  );
  return parseTimekeeperScopeRows(rows);
}

/** Как loadTimekeeperScopeSnapshot, но с кэшем на req: один снимок на HTTP-запрос. */
async function resolveScopeSnapshot(req: AuthenticatedRequest): Promise<ITimekeeperScopeSnapshot> {
  if (req.user.__timekeeper_scope_snapshot) return req.user.__timekeeper_scope_snapshot;
  const snapshot = await loadTimekeeperScopeSnapshot(req.user.id);
  req.user.__timekeeper_scope_snapshot = snapshot;
  return snapshot;
}

/**
 * Видимые табельщице отделы = ПЕРЕСЕЧЕНИЕ:
 *   - «присутствуют на её объектах» (две ветки): ручная привязка
 *     employee_skud_object_access И фактические проходы СКУД за окно;
 *   - «входят в выбранные папки»: поддерево timekeeper_folder_access.
 * Папки не выбраны → пусто (строго): табельщица не видит никого.
 *
 * Совместимая обёртка над снапшотом — сигнатура сохранена, зовётся из многих мест.
 */
export async function listTimekeeperDepartmentSeeds(timekeeperUserId: string): Promise<string[]> {
  return (await loadTimekeeperScopeSnapshot(timekeeperUserId)).departmentSeeds;
}

/**
 * Сотрудники объектов табельщицы из трёх источников: явное назначение
 * (employee_object_assignment), место работы СКУД (employee_skud_object_access),
 * фактические проходы за окно. Совместимая обёртка над снапшотом.
 */
export async function listTimekeeperDirectEmployeeIds(timekeeperUserId: string): Promise<number[]> {
  return (await loadTimekeeperScopeSnapshot(timekeeperUserId)).directEmployeeIds;
}

/**
 * Как listTimekeeperDepartmentSeeds, но из req-снимка.
 * Subtree-расширение делает resolveAccessibleDepartmentIds.
 */
export async function resolveTimekeeperDepartmentSeeds(req: AuthenticatedRequest): Promise<string[]> {
  if (req.user.__timekeeper_dept_seeds) return req.user.__timekeeper_dept_seeds;
  const seeds = (await resolveScopeSnapshot(req)).departmentSeeds;
  req.user.__timekeeper_dept_seeds = seeds;
  return seeds;
}

/**
 * Как listTimekeeperDirectEmployeeIds, но Set из того же req-снимка.
 * Эквивалент «прямых подчинённых» для скоупа табельщицы.
 */
export async function resolveTimekeeperDirectEmployeeIds(req: AuthenticatedRequest): Promise<Set<number>> {
  if (req.user.__timekeeper_direct_employees) return req.user.__timekeeper_direct_employees;
  const ids = new Set((await resolveScopeSnapshot(req)).directEmployeeIds);
  req.user.__timekeeper_direct_employees = ids;
  return ids;
}

/**
 * Полное поддерево доступных отделов табельщицы (семена + все потомки).
 * Для buildProfileResponse → managed_department_ids: фронт показывает в селекторе
 * все дочерние бригады, даже если объект назначен на родительский отдел.
 *
 * Принимает готовые seeds, чтобы профиль не выполнял снимок повторно.
 */
export async function expandTimekeeperAccessibleDepartmentIds(seeds: string[]): Promise<string[]> {
  if (seeds.length === 0) return [];
  const rows = await query<{ id: string }>(
    'SELECT id FROM public.get_descendant_department_ids($1::uuid[])',
    [seeds],
  );
  const subtree = rows.map(r => r.id);
  // ЛИНИЯ-Общестрой — соседняя ветка (не бригада), но табельщица ведёт её людей по
  // присутствию, поэтому даём выбрать отдел в «По отделу». Состав грида сузится до её
  // людей (isTimekeeperLiDeptView), правка — только по присутствие-набору (edit-гейт).
  // Это только профильный managed_department_ids (селектор), не backend-скоуп.
  return [...new Set([...seeds, ...subtree, LI_OBSHESTROY_DEPARTMENT_ID])];
}

/** Совместимая обёртка: снимок + расширение поддеревом. */
export async function listTimekeeperAccessibleDepartmentIds(timekeeperUserId: string): Promise<string[]> {
  const seeds = await listTimekeeperDepartmentSeeds(timekeeperUserId);
  return expandTimekeeperAccessibleDepartmentIds(seeds);
}

/**
 * Сотрудники «ЛИНИЯ-Общестрой» (по ТЕКУЩЕМУ employees.org_department_id, не по
 * employee_department_access — там бывают протухшие active-строки из sigur_sync
 * у людей, реально переведённых в другую бригаду), присутствующие на любом из
 * объектов табельщицы В ВЫБРАННОМ ПЕРИОДЕ [startDate, endDate]. «Присутствие» =
 * явное назначение employee_object_assignment, ручная привязка
 * employee_skud_object_access, ИЛИ фактические проходы skud_events в пределах
 * периода (не 90 дней — иначе тянет «хвост» ИТР, засветившихся раз за квартал).
 * Не члены её бригад, показываются отдельной секцией после бригады в Табеле.
 */
export async function resolveTimekeeperLiObshestroyPresenceIds(
  req: AuthenticatedRequest,
  startDate: string,
  endDate: string,
): Promise<Set<number>> {
  const rows = await query<{ id: number | string }>(
    `SELECT DISTINCT e.id
       FROM employees e
      WHERE e.org_department_id = $2::uuid
        AND e.employment_status = 'active' AND e.is_archived = false
        AND e.id IN (
          SELECT eoa.employee_id
            FROM timekeeper_object_access toa
            JOIN employee_object_assignment eoa
              ON eoa.skud_object_id = toa.skud_object_id AND eoa.is_active = true
           WHERE toa.timekeeper_user_id = $1::uuid AND toa.is_active = true
          UNION
          SELECT esoa.employee_id
            FROM timekeeper_object_access toa
            JOIN employee_skud_object_access esoa
              ON esoa.skud_object_id = toa.skud_object_id AND esoa.is_active = true
           WHERE toa.timekeeper_user_id = $1::uuid AND toa.is_active = true
          UNION
          SELECT se.employee_id
            FROM timekeeper_object_access toa
            JOIN skud_object_access_points sap ON sap.object_id = toa.skud_object_id
            JOIN skud_events se
              ON BTRIM(se.access_point) = BTRIM(sap.access_point_name)
             AND se.event_date >= $3::date AND se.event_date <= $4::date
           WHERE toa.timekeeper_user_id = $1::uuid AND toa.is_active = true
        )`,
    [req.user.id, LI_OBSHESTROY_DEPARTMENT_ID, startDate, endDate],
  );
  return new Set(
    rows.map(r => Number(r.id)).filter((id): id is number => Number.isInteger(id)),
  );
}

/**
 * Множество ЛИНИЯ-Общестрой-сотрудников на объектах табельщицы для АВТОРИЗАЦИИ ПРАВКИ
 * (не для показа): `resolveTimekeeperDirectEmployeeIds` (90-дневное присутствие по всем
 * её объектам) ∩ org_department_id = ЛИНИЯ-Общестрой. Шире, чем период-версия для показа
 * (`resolveTimekeeperLiObshestroyPresenceIds`), т.к. гейт правки не зависит от выбранного
 * периода — но строго ограничен LI на её объектах (не пускает чужих ИТР/подрядных).
 * Кэш на `req.user.__timekeeper_editable_li`.
 */
export async function resolveTimekeeperEditableLiIds(req: AuthenticatedRequest): Promise<Set<number>> {
  if (req.user.__timekeeper_editable_li) return req.user.__timekeeper_editable_li;
  const direct = await resolveTimekeeperDirectEmployeeIds(req);
  if (direct.size === 0) {
    req.user.__timekeeper_editable_li = new Set();
    return req.user.__timekeeper_editable_li;
  }
  const rows = await query<{ id: number | string }>(
    `SELECT id FROM employees
      WHERE id = ANY($1::int[]) AND org_department_id = $2::uuid
        AND employment_status = 'active' AND is_archived = false`,
    [[...direct], LI_OBSHESTROY_DEPARTMENT_ID],
  );
  const set = new Set(
    rows.map(r => Number(r.id)).filter((id): id is number => Number.isInteger(id)),
  );
  req.user.__timekeeper_editable_li = set;
  return set;
}
