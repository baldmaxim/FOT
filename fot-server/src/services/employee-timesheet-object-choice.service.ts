/**
 * Выбор объекта табелирования вручную (миграция 288).
 *
 * Два пути:
 *   - сотрудник сам в ЛК (actor = 'employee', set_by = 'employee');
 *   - тот, кто ведёт табель сотрудника, — табельщица, руководитель отдела (actor =
 *     'manager', set_by = 'manager'). Права проверяет контроллер.
 *
 * Правила одни для обоих:
 *   - только свои работающие сотрудники (не подрядчики, не уволенные, не архив);
 *   - только в последние 3 дня месяца; у ведущего табель исключение — сотруднику
 *     без объекта (новичок без проходов) первый объект ставится в любой день;
 *   - пока прошлый месяц не зафиксирован, менять нельзя: выбор попал бы в него;
 *   - в списке только объекты, где у сотрудника больше 24 ч с 1-го числа, плюс
 *     текущий и то, к чему можно вернуться после ручной смены (значение по умолчанию
 *     от отдела и прежние объекты этого месяца); новичку без объекта ведущий табель
 *     выбирает из всех объектов.
 * Ночной расчёт ручной выбор не перезаписывает.
 */
import type { AuthenticatedRequest } from '../types/index.js';
import { query, queryOne, withTransaction } from '../config/postgres.js';
import { invalidateCaches } from '../middleware/cacheResponse.js';
import { moscowTodayIso } from '../utils/date.utils.js';
import { AUDIT_ACTIONS, auditService } from './audit.service.js';
import { employeeCache } from './employee-cache.service.js';
import {
  DEFAULT_EXPORT_MODE,
  TIMESHEET_MODE_LOCK_KEY,
  currentMonthStartMsk,
  resolveExportModes,
  type TimesheetExportMode,
} from './timesheet-export-mode.service.js';
import {
  OFFICE_LABEL,
  OFFICE_VALUE,
  TIMESHEET_OBJECT_MIN_HOURS,
  canonicalizeMode,
  isOfficeAddress,
  isPreviousMonthFrozen,
  isTimesheetObjectWindowOpen,
  labelForResolved,
  loadContractorDepartmentIds,
  loadSkudObjects,
  loadTimesheetObjectHours,
  valueForResolved,
  type ISkudObjectInfo,
  type TimesheetObjectSetBy,
} from './employee-timesheet-object.service.js';

export type TimesheetObjectActor = 'employee' | 'manager';

export interface ITimesheetObjectOption {
  value: string;
  label: string;
}

export interface ITimesheetObjectState {
  label: string | null;
  value: string | null;
  can_change: boolean;
  options: ITimesheetObjectOption[];
}

export type TimesheetObjectErrorCode =
  | 'EMPLOYEE_NOT_FOUND'
  | 'TIMESHEET_OBJECT_NOT_ELIGIBLE'
  | 'TIMESHEET_OBJECT_PREVIOUS_MONTH_NOT_FROZEN'
  | 'TIMESHEET_OBJECT_WINDOW_CLOSED'
  | 'TIMESHEET_OBJECT_NOT_ALLOWED';

export class TimesheetObjectError extends Error {
  readonly status: number;
  readonly code: TimesheetObjectErrorCode;

  constructor(status: number, code: TimesheetObjectErrorCode, message: string) {
    super(message);
    this.name = 'TimesheetObjectError';
    this.status = status;
    this.code = code;
  }
}

interface IEmployeeRow {
  id: number;
  full_name: string | null;
  employment_status: string | null;
  is_archived: boolean | null;
  org_department_id: string | null;
}

interface IChoiceContext {
  employee: IEmployeeRow;
  objectsById: Map<string, ISkudObjectInfo>;
  label: string | null;
  value: string | null;
  eligible: boolean;
  previousMonthFrozen: boolean;
  canChange: boolean;
}

/** Решение «можно ли менять» — чистая функция ради тестов. */
export function canChangeTimesheetObject(input: {
  actor: TimesheetObjectActor;
  eligible: boolean;
  previousMonthFrozen: boolean;
  windowOpen: boolean;
  hasObject: boolean;
}): boolean {
  if (!input.eligible || !input.previousMonthFrozen) return false;
  if (input.windowOpen) return true;
  return input.actor === 'manager' && !input.hasObject;
}

/**
 * Список выбора: объекты > 24 ч с 1-го числа + текущий. hoursList — уже сгруппирован
 * («Офис» — суммой) и отсортирован по часам.
 */
export function buildHoursOptions(
  hoursList: ReadonlyArray<{ value: string; label: string; hours: number }>,
  current: { value: string | null; label: string | null },
): ITimesheetObjectOption[] {
  const options: ITimesheetObjectOption[] = hoursList
    .filter(item => item.hours > TIMESHEET_OBJECT_MIN_HOURS || item.value === current.value)
    .map(item => ({ value: item.value, label: item.label }));
  if (current.value && current.label && !options.some(option => option.value === current.value)) {
    options.push({ value: current.value, label: current.label });
  }
  return options;
}

/** Добавляет пункты, которых ещё нет в списке (по значению). */
export function appendOptions(
  base: readonly ITimesheetObjectOption[],
  extra: readonly ITimesheetObjectOption[],
): ITimesheetObjectOption[] {
  const result = [...base];
  for (const option of extra) {
    if (!result.some(existing => existing.value === option.value)) result.push(option);
  }
  return result;
}

/** Все активные объекты: «Офис» одним пунктом, остальные по имени. */
export function buildAllObjectOptions(objectsById: ReadonlyMap<string, ISkudObjectInfo>): ITimesheetObjectOption[] {
  const active = [...objectsById.values()].filter(object => object.is_active);
  const options: ITimesheetObjectOption[] = [];
  if (active.some(object => isOfficeAddress(object.alt_name))) {
    options.push({ value: OFFICE_VALUE, label: OFFICE_LABEL });
  }
  const collator = new Intl.Collator('ru');
  for (const object of active
    .filter(item => !isOfficeAddress(item.alt_name))
    .sort((a, b) => collator.compare(a.name, b.name) || (a.id < b.id ? -1 : 1))) {
    options.push({ value: object.id, label: object.name });
  }
  return options;
}

async function loadEmployee(employeeId: number): Promise<IEmployeeRow | null> {
  const row = await queryOne<IEmployeeRow>(
    `SELECT id, full_name, employment_status, is_archived, org_department_id::text AS org_department_id
       FROM employees WHERE id = $1`,
    [employeeId],
  );
  return row ? { ...row, id: Number(row.id) } : null;
}

async function loadContext(
  employeeId: number,
  actor: TimesheetObjectActor,
  now: Date,
): Promise<IChoiceContext> {
  const employee = await loadEmployee(employeeId);
  if (!employee) throw new TimesheetObjectError(404, 'EMPLOYEE_NOT_FOUND', 'Сотрудник не найден');

  const [objectsById, modes, contractorIds, previousMonthFrozen] = await Promise.all([
    loadSkudObjects(),
    resolveExportModes([employeeId]),
    loadContractorDepartmentIds(),
    isPreviousMonthFrozen(now),
  ]);
  const resolved = modes.get(employeeId) ?? DEFAULT_EXPORT_MODE;
  const label = labelForResolved(resolved, objectsById);
  const value = valueForResolved(resolved, objectsById);
  const contractor = employee.org_department_id != null && contractorIds.includes(employee.org_department_id);
  const eligible = employee.employment_status === 'active' && employee.is_archived !== true && !contractor;

  return {
    employee,
    objectsById,
    label,
    value,
    eligible,
    previousMonthFrozen,
    canChange: canChangeTimesheetObject({
      actor,
      eligible,
      previousMonthFrozen,
      windowOpen: isTimesheetObjectWindowOpen(now),
      hasObject: label !== null,
    }),
  };
}

/**
 * Действия аудита, чьи old_* — прежний объект сотрудника (личный режим). Функция, а не
 * константа модуля: тесты с моком audit.service без AUDIT_ACTIONS грузят app.ts.
 */
const revertableAuditActions = (): string[] => [
  AUDIT_ACTIONS.TIMESHEET_OBJECT_SELF_SELECTED,
  AUDIT_ACTIONS.TIMESHEET_OBJECT_MANAGER_SELECTED,
  AUDIT_ACTIONS.TIMESHEET_MODE_UPDATED,
];

/**
 * Куда можно вернуться после ручной смены: значение по умолчанию (от отдела и
 * legacy-назначений, без личного режима) и объекты, которые были до ручных смен в
 * этом месяце (журнал аудита). Без этого случайную смену не откатить: у прежнего
 * объекта часов может быть меньше 24 — например, «Офис» отдела при работе на объекте.
 */
async function loadRevertOptions(
  employeeId: number,
  objectsById: ReadonlyMap<string, ISkudObjectInfo>,
  now: Date,
): Promise<ITimesheetObjectOption[]> {
  const options: ITimesheetObjectOption[] = [];
  const add = (value: string | null, label: string | null): void => {
    if (value && label && !options.some(option => option.value === value)) options.push({ value, label });
  };

  const defaults = await resolveExportModes([employeeId], undefined, { ignorePersonal: true });
  const fallback = defaults.get(employeeId) ?? DEFAULT_EXPORT_MODE;
  add(valueForResolved(fallback, objectsById), labelForResolved(fallback, objectsById));

  const rows = await query<{ old_mode: string | null; old_object_id: string | null }>(
    `SELECT details->>'old_mode' AS old_mode, details->>'old_object_id' AS old_object_id
       FROM audit_logs
      WHERE entity_type = 'employee'
        AND entity_id = $1
        AND action = ANY($2::text[])
        AND created_at >= $3::timestamptz
      ORDER BY created_at DESC`,
    [String(employeeId), revertableAuditActions(), `${currentMonthStartMsk(now)}T00:00:00+03:00`],
  );
  for (const row of rows) {
    // NULL — «личного режима не было»: это значение по умолчанию, оно уже в списке.
    if (row.old_mode === 'current_activity') {
      add(OFFICE_VALUE, OFFICE_LABEL);
      continue;
    }
    if (row.old_mode !== 'object' || !row.old_object_id) continue;
    // Неактивный объект вернуть нельзя — запись режима требует активный объект.
    const object = objectsById.get(row.old_object_id);
    if (!object?.is_active) continue;
    const resolved = { mode: 'object' as const, pinnedObjectId: object.id, source: 'employee_explicit' as const };
    add(valueForResolved(resolved, objectsById), labelForResolved(resolved, objectsById));
  }
  return options;
}

async function loadOptions(
  context: IChoiceContext,
  actor: TimesheetObjectActor,
  now: Date,
): Promise<ITimesheetObjectOption[]> {
  if (actor === 'manager' && context.label === null) return buildAllObjectOptions(context.objectsById);
  const today = moscowTodayIso(now);
  const [hours, revert] = await Promise.all([
    loadTimesheetObjectHours(
      [context.employee.id],
      { start: currentMonthStartMsk(now), end: today },
      { todayStr: today, objectsById: context.objectsById },
    ),
    loadRevertOptions(context.employee.id, context.objectsById, now),
  ]);
  const byHours = buildHoursOptions(hours.get(context.employee.id) ?? [], {
    value: context.value,
    label: context.label,
  });
  return appendOptions(byHours, revert);
}

/** Состояние для ЛК и окна в табеле. Список считается только когда менять можно. */
export async function getTimesheetObjectState(
  employeeId: number,
  actor: TimesheetObjectActor,
  now: Date = new Date(),
): Promise<ITimesheetObjectState> {
  const context = await loadContext(employeeId, actor, now);
  return {
    label: context.label,
    value: context.value,
    can_change: context.canChange,
    options: context.canChange ? await loadOptions(context, actor, now) : [],
  };
}

function invalidateTimesheetCaches(): void {
  invalidateCaches(
    'timesheet',
    'timesheet:today',
    'timesheet:overview',
    'timesheet:overview:today',
    'timesheet:search',
  );
}

/**
 * Записывает выбор. Повтор того же выбора тем же источником — без UPDATE и аудита.
 * Возвращает новое состояние.
 */
export async function setTimesheetObject(
  req: AuthenticatedRequest,
  employeeId: number,
  rawValue: string,
  actor: TimesheetObjectActor,
  now: Date = new Date(),
): Promise<{ changed: boolean; state: ITimesheetObjectState }> {
  const context = await loadContext(employeeId, actor, now);
  if (!context.eligible) {
    throw new TimesheetObjectError(
      400, 'TIMESHEET_OBJECT_NOT_ELIGIBLE',
      'Объект табелирования ставится только работающим сотрудникам организации',
    );
  }
  if (!context.previousMonthFrozen) {
    throw new TimesheetObjectError(
      409, 'TIMESHEET_OBJECT_PREVIOUS_MONTH_NOT_FROZEN',
      'Объект за прошлый месяц ещё фиксируется — попробуйте позже',
    );
  }
  if (!context.canChange) {
    throw new TimesheetObjectError(
      409, 'TIMESHEET_OBJECT_WINDOW_CLOSED',
      'Объект табелирования можно изменить только в последние 3 дня месяца',
    );
  }

  const options = await loadOptions(context, actor, now);
  if (!options.some(option => option.value === rawValue)) {
    throw new TimesheetObjectError(
      400, 'TIMESHEET_OBJECT_NOT_ALLOWED',
      'Этот объект нельзя выбрать: на нём меньше 24 ч с начала месяца',
    );
  }

  const target = rawValue === OFFICE_VALUE
    ? { mode: 'current_activity' as TimesheetExportMode, objectId: null }
    : canonicalizeMode('object', rawValue, context.objectsById);
  const setBy: TimesheetObjectSetBy = actor === 'employee' ? 'employee' : 'manager';

  const changed = await withTransaction(async client => {
    // Тот же ключ берут админские пути, ночной расчёт и скрипты режимов.
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [TIMESHEET_MODE_LOCK_KEY]);
    const before = (await client.query<{
      timesheet_export_mode: TimesheetExportMode | null;
      timesheet_export_object_id: string | null;
      timesheet_export_set_by: TimesheetObjectSetBy | null;
    }>(
      `SELECT timesheet_export_mode, timesheet_export_object_id::text, timesheet_export_set_by
         FROM employees WHERE id = $1::int FOR UPDATE`,
      [employeeId],
    )).rows[0];
    if (!before) return false;

    const sameMode = before.timesheet_export_mode === target.mode
      && (before.timesheet_export_object_id ?? null) === (target.objectId ?? null);
    if (sameMode && before.timesheet_export_set_by === setBy) return false;

    // Автор и время (289): без новой даты триггер считает запись не человеческой.
    await client.query(
      `UPDATE employees
          SET timesheet_export_mode = $1,
              timesheet_export_object_id = $2::uuid,
              timesheet_export_set_by = $3,
              timesheet_export_set_by_user_id = $5::uuid,
              timesheet_export_set_at = now(),
              updated_at = now()
        WHERE id = $4::int`,
      [target.mode, target.objectId, setBy, employeeId, req.user.id],
    );
    await auditService.logFromRequestWithClient(
      client, req, req.user.id,
      actor === 'employee'
        ? AUDIT_ACTIONS.TIMESHEET_OBJECT_SELF_SELECTED
        : AUDIT_ACTIONS.TIMESHEET_OBJECT_MANAGER_SELECTED,
      {
        entityType: 'employee',
        entityId: String(employeeId),
        details: {
          employee_name: context.employee.full_name,
          old_mode: before.timesheet_export_mode,
          old_object_id: before.timesheet_export_object_id,
          old_set_by: before.timesheet_export_set_by,
          new_mode: target.mode,
          new_object_id: target.objectId,
          new_set_by: setBy,
        },
      },
    );
    return true;
  });

  if (changed) {
    employeeCache.invalidate(employeeId);
    invalidateTimesheetCaches();
  }
  return { changed, state: await getTimesheetObjectState(employeeId, actor, now) };
}
