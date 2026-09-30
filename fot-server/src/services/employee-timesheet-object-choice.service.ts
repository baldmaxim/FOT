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
 *   - кому «Офис» поставлен в окне «Режим табелирования» — лично или через отдел
 *     (миграция 291), — менять нельзя никому;
 *   - только в последние 3 дня месяца; у ведущего табель исключение — сотруднику
 *     без объекта (новичок без проходов) первый объект ставится в любой день;
 *   - пока прошлый месяц не зафиксирован, менять нельзя: выбор попал бы в него;
 *   - выбрать можно из двух объектов с наибольшими часами с 1-го числа, и только если
 *     второй отстаёт от первого меньше чем на 15 % (от большего); текущий — в списке для
 *     показа. Нет второго — нет и выбора. Новичку без объекта ведущий табель выбирает
 *     из всех объектов.
 * Ночной расчёт ручной выбор не перезаписывает, и в следующих месяцах тоже.
 */
import type { AuthenticatedRequest } from '../types/index.js';
import { queryOne, withTransaction } from '../config/postgres.js';
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
  TIMESHEET_OBJECT_CHOICE_GAP,
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
import { isTimesheetOfficeLocked } from './timesheet-office-rule.js';

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
  | 'TIMESHEET_OBJECT_NOT_ALLOWED'
  | 'TIMESHEET_OBJECT_LOCKED';

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
  /** «Офис» из окна «Режим табелирования» — лично или через отдел (291). */
  locked: boolean;
  canChange: boolean;
}

/** Решение «можно ли менять» — чистая функция ради тестов. */
export function canChangeTimesheetObject(input: {
  actor: TimesheetObjectActor;
  eligible: boolean;
  previousMonthFrozen: boolean;
  windowOpen: boolean;
  hasObject: boolean;
  locked?: boolean;
}): boolean {
  if (input.locked || !input.eligible || !input.previousMonthFrozen) return false;
  if (input.windowOpen) return true;
  return input.actor === 'manager' && !input.hasObject;
}

/** Погрешность сравнения долей: ровно 15 % — уже не «меньше 15 %». */
const CHOICE_GAP_EPSILON = 1e-9;

/**
 * Список выбора: первый объект по часам — всегда, второй — если отстаёт от первого меньше
 * чем на 15 % от большего; текущий — для показа. hoursList — уже сгруппирован («Офис» —
 * суммой) и отсортирован по часам тем же порядком, что у ночного расчёта.
 */
export function buildHoursOptions(
  hoursList: ReadonlyArray<{ value: string; label: string; hours: number }>,
  current: { value: string | null; label: string | null },
): ITimesheetObjectOption[] {
  const [first, second] = hoursList;
  const options: ITimesheetObjectOption[] = [];
  if (first) options.push({ value: first.value, label: first.label });
  if (first && second && first.hours - second.hours < first.hours * TIMESHEET_OBJECT_CHOICE_GAP - CHOICE_GAP_EPSILON) {
    options.push({ value: second.value, label: second.label });
  }
  if (current.value && current.label && !options.some(option => option.value === current.value)) {
    options.push({ value: current.value, label: current.label });
  }
  return options;
}

/** Есть ли на что сменить: пункт, отличный от текущего значения. */
export function hasAlternativeOption(
  options: readonly ITimesheetObjectOption[],
  currentValue: string | null,
): boolean {
  return options.some(option => option.value !== currentValue);
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

  const [objectsById, modes, contractorIds, previousMonthFrozen, locked] = await Promise.all([
    loadSkudObjects(),
    resolveExportModes([employeeId]),
    loadContractorDepartmentIds(),
    isPreviousMonthFrozen(now),
    isTimesheetOfficeLocked(employeeId),
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
    locked,
    canChange: canChangeTimesheetObject({
      actor,
      eligible,
      previousMonthFrozen,
      windowOpen: isTimesheetObjectWindowOpen(now),
      hasObject: label !== null,
      locked,
    }),
  };
}

async function loadOptions(
  context: IChoiceContext,
  actor: TimesheetObjectActor,
  now: Date,
): Promise<ITimesheetObjectOption[]> {
  if (actor === 'manager' && context.label === null) return buildAllObjectOptions(context.objectsById);
  const today = moscowTodayIso(now);
  const hours = await loadTimesheetObjectHours(
    [context.employee.id],
    { start: currentMonthStartMsk(now), end: today },
    { todayStr: today, objectsById: context.objectsById },
  );
  return buildHoursOptions(hours.get(context.employee.id) ?? [], {
    value: context.value,
    label: context.label,
  });
}

/**
 * Состояние для ЛК и окна в табеле. Список считается только когда менять можно; менять
 * можно, только если в списке есть что-то кроме текущего значения — иначе текст.
 */
export async function getTimesheetObjectState(
  employeeId: number,
  actor: TimesheetObjectActor,
  now: Date = new Date(),
): Promise<ITimesheetObjectState> {
  const context = await loadContext(employeeId, actor, now);
  const options = context.canChange ? await loadOptions(context, actor, now) : [];
  const canChange = hasAlternativeOption(options, context.value);
  return {
    label: context.label,
    value: context.value,
    can_change: canChange,
    options: canChange ? options : [],
  };
}

const lockedError = (): TimesheetObjectError => new TimesheetObjectError(
  409, 'TIMESHEET_OBJECT_LOCKED',
  'Объект «Офис» назначен в режиме табелирования — сменить нельзя',
);

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
  if (context.locked) throw lockedError();
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
  if (!hasAlternativeOption(options, context.value) || !options.some(option => option.value === rawValue)) {
    throw new TimesheetObjectError(
      400, 'TIMESHEET_OBJECT_NOT_ALLOWED',
      'Можно выбрать объект с наибольшими часами или второй, если разница меньше 15 %',
    );
  }

  const target = rawValue === OFFICE_VALUE
    ? { mode: 'current_activity' as TimesheetExportMode, objectId: null }
    : canonicalizeMode('object', rawValue, context.objectsById);
  const setBy: TimesheetObjectSetBy = actor === 'employee' ? 'employee' : 'manager';

  const changed = await withTransaction(async client => {
    // Тот же ключ берут окно «Режим табелирования», ночной расчёт, дедуп и слияние отделов.
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
    // «Офис» могли поставить в окне между чтением и записью — проверка под тем же локом.
    if (await isTimesheetOfficeLocked(employeeId, client)) throw lockedError();

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
