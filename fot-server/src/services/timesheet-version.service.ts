// Материализация официальной версии закрытого табеля.
//
// Закрытый согласованный табель — неизменяемый снимок: версия создаётся при approve
// и при каждом закрытии утверждённого периода, а API для 1С отдаёт её как есть и
// никогда не пересчитывает. Фоновый пересчёт СКУД на сохранённую версию не влияет.
//
// Все чтения идут через переданный клиент транзакции (см. timesheet-snapshot-tx.ts):
// payload обязан собираться из ОДНОГО снимка БД.

import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import type { DbExecutor } from '../config/postgres.js';
import { canonicalJson } from '../utils/canonical-json.js';
import { fetchTimesheetDataForEmployees } from './timesheet-export.service.js';
import { buildFiredCutoffMap, isFiredHiddenForPeriod } from './timesheet-fired-cutoff.service.js';
import { resolveExportModes, type IResolvedExportMode } from './timesheet-export-mode.service.js';
import {
  buildVersionObjectBreakdown,
  computeObjectsContentHash,
  type IObjectConfigError,
  type IObjectMeta,
  type IVersionObjectsEmployee,
  type IVersionObjectsPayload,
} from './timesheet-object-breakdown.service.js';
import { UNKNOWN_OBJECT_KEY, type IAttendanceObjectEntry } from './timesheet-object.service.js';
import { listDepartmentManagers } from './department-managers.service.js';
import { listEmployeeDepartmentPeriodsBulk } from './timesheet-employee-periods.service.js';
import {
  buildVersionManagersSnapshot,
  computeManagersContentHash,
  type IEmployeeDepartmentResolution,
  type IManagerMeta,
  type IVersionManagersPayload,
} from './timesheet-managers-snapshot.service.js';
import { hasRealActivity } from './attendance.service.js';
import { listApprovalEmployees } from './timesheet-approval-employees-snapshot.service.js';
import { listEmployeeMembershipsForDepartmentPeriod } from './timesheet-department-assignments.service.js';
import { listBrigadeSupervisorEmployeeIdsForDepartments } from '../controllers/timesheet-assigned-export.controller.js';
import {
  findApprovalLocksForEmployeeDates,
  type ITimesheetLockPair,
} from './timesheet-lock.service.js';
import {
  enumerateDatesInclusive,
  ownershipKey,
  ownsDay,
  resolveDayOwnership,
} from './timesheet-day-ownership.service.js';
import type { IApprovalLockInfo } from './timesheet-department-assignments.service.js';

// 'rebuild' — аварийная пересборка фоновым воркером. В штатном процессе не возникает:
// закрытый табель правится только через «Открыть → Закрыть», и это даёт source='close'.
// Остаётся для операторского восстановления после ручной правки БД (миграция 257).
// 'objects' — новая редакция только из-за смены объекта табелирования после фиксации
// месяца (миграция 288): payload и content_hash прежние, меняется объектная разбивка.
export type TimesheetVersionSource = 'approve' | 'close' | 'backfill' | 'rebuild' | 'objects';
export type TimesheetExportState = 'not_exported' | 'stale' | 'exported';

/** Подача в том виде, в каком она нужна материализации. */
export interface IVersionApproval {
  id: number;
  department_id: string | null;
  manager_employee_id: number | null;
  start_date: string;
  end_date: string;
  status: string;
}

export interface IVersionDayValue {
  status: string;
  hours: number;
  corrected: boolean;
  hours_overridden: boolean;
}

export interface IVersionEmployee {
  identity: {
    employee_id: number;
    sigur_employee_id: number | null;
    tab_number: string | null;
    full_name: string | null;
  };
  position: string | null;
  total_hours: number;
  /**
   * true — за период нет ни одного реального сигнала; 1С такие строки не переносит.
   * Начальникам участков и назначенным в окне «Режим табелирования» — false всегда.
   */
  zero_activity: boolean;
  days: Record<string, IVersionDayValue>;
  /**
   * Историческое зарезервированное поле контракта 1С. Остаётся пустым намеренно:
   * объектная разбивка живёт отдельным снимком (timesheet_version_objects) и отдаётся
   * методом /timesheets/{id}/objects. Класть её сюда нельзя — изменился бы
   * content_hash, и все уже выгруженные табели пришлось бы перезабирать.
   */
  object_rows: unknown[];
}

export interface ITimesheetVersionPayload {
  approval: {
    id: number;
    scope: {
      kind: 'department' | 'personal';
      department_id: string | null;
      department_name: string | null;
      manager_employee_id: number | null;
    };
    start_date: string;
    end_date: string;
    status: string;
  };
  employees_count: number;
  total_hours: number;
  employees: IVersionEmployee[];
}

export interface ITimesheetVersionRow {
  id: number;
  approval_id: number;
  revision: number;
  content_hash: string;
  employees_count: number;
  total_hours: number;
  created_at: string;
  payload?: ITimesheetVersionPayload;
}

/**
 * Согласованный ростер не удалось собрать целиком. Официальной версии с потерянными
 * людьми существовать не должно, поэтому approve/close откатывается целиком.
 */
export class TimesheetVersionIncompleteError extends Error {
  readonly code = 'TIMESHEET_VERSION_INCOMPLETE';
  readonly missingEmployeeIds: number[];

  constructor(missingEmployeeIds: number[]) {
    super(
      `Не удалось собрать полный состав табеля: потеряно сотрудников — ${missingEmployeeIds.length}`,
    );
    this.name = 'TimesheetVersionIncompleteError';
    this.missingEmployeeIds = missingEmployeeIds;
  }
}

/** Снимок состава пуст — материализовать нечего. */
export class TimesheetVersionEmptyRosterError extends Error {
  readonly code = 'TIMESHEET_VERSION_EMPTY_ROSTER';

  constructor(approvalId: number) {
    super(`У подачи ${approvalId} нет снимка состава — версию собрать не из чего`);
    this.name = 'TimesheetVersionEmptyRosterError';
  }
}

/**
 * Период подачи пересекает границу месяца (миграция 288). Объект табелирования
 * фиксируется помесячно, и одной редакции нельзя приписать один режим на два месяца.
 * Новые такие подачи запрещены валидатором периода; эта ошибка — защита для старых.
 */
export class TimesheetVersionCrossMonthError extends Error {
  readonly code = 'CROSS_MONTH_RANGE';

  constructor(startDate: string, endDate: string) {
    super(`Период ${startDate} — ${endDate} пересекает границу месяца`);
    this.name = 'TimesheetVersionCrossMonthError';
  }
}

/** Месяцы (первые числа), которые пересекает период. */
export function monthAnchorsInRange(startDate: string, endDate: string): string[] {
  const anchors: string[] = [];
  const cursor = new Date(`${startDate.slice(0, 8)}01T00:00:00Z`);
  const stop = new Date(`${endDate.slice(0, 8)}01T00:00:00Z`);
  while (cursor <= stop) {
    anchors.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return anchors;
}

function lastDayOfMonth(anchor: string): string {
  const date = new Date(`${anchor.slice(0, 8)}01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + 1);
  date.setUTCDate(0);
  return date.toISOString().slice(0, 10);
}

/**
 * md5 всего фактического payload — включая identity, zero_activity, object_rows и итоги.
 * Хэшируется именно то, что уходит в 1С: смена табельного номера, состава или одного
 * флага zero_activity обязана менять хэш.
 */
export function computeContentHash(payload: ITimesheetVersionPayload): string {
  return crypto.createHash('md5').update(canonicalJson(payload)).digest('hex');
}

/**
 * zero_activity — одно правило для утверждения и пересборки: нет реального сигнала на своих
 * днях, не начальник участка и не назначен в окне «Режим табелирования» (291) — назначенный
 * уходит в 1С и при всех «Н», с объектом и нулём часов.
 */
export function isZeroActivity(
  employeeId: number,
  activeIds: ReadonlySet<number>,
  supervisorIds: ReadonlySet<number>,
  modeByEmployee: ReadonlyMap<number, IResolvedExportMode>,
): boolean {
  return !activeIds.has(employeeId)
    && !supervisorIds.has(employeeId)
    && modeByEmployee.get(employeeId)?.windowPin !== true;
}

/** Снимок объектной разбивки, собранный вместе с версией. */
export interface IVersionObjectsSnapshot {
  payload: IVersionObjectsPayload;
  hash: string;
  configErrors: IObjectConfigError[];
  employeesCount: number;
  totalHours: number;
}

/** Снимок руководителей отдела, собранный вместе с версией. */
export interface IVersionManagersSnapshot {
  payload: IVersionManagersPayload;
  hash: string;
  employeesCount: number;
  withoutManager: number;
}

export interface IBuiltVersion {
  payload: ITimesheetVersionPayload;
  membershipWindows: Record<string, IMembershipWindow>;
  objects: IVersionObjectsSnapshot;
  managers: IVersionManagersSnapshot;
}

interface IMembershipWindow {
  /** Нижняя граница членства в отделе (включительно); null — с начала периода. */
  joined_date: string | null;
  /** Дата, с которой сотрудник выбыл из отдела из-за перевода; null — остался. */
  transferred_out_date: string | null;
  /** Вход в отдел — следствие настоящего перевода, а не артефакт effective_from. */
  joined_via_transfer: boolean;
}

/**
 * Объектные интервалы сохранённой редакции, отфильтрованные владением днём.
 *
 * Владение обязано быть тем же, что у основного payload: иначе переведённый в середине
 * периода унёс бы объектные часы новой бригады в выгрузку старой. Поэтому оно берётся
 * из самой редакции — в payload попали ровно дни, которыми подача владела при закрытии.
 * Пересчёт по текущему правилу здесь нельзя: если сотрудник в двух подачах и правило
 * с тех пор поменялось, разбивка разошлась бы с днями табеля этой же редакции.
 */
async function collectOwnedObjectEntries(
  client: PoolClient,
  approval: IVersionApproval,
  payload: ITimesheetVersionPayload,
): Promise<{
  objectEntries: IAttendanceObjectEntry[];
  ownsEmployeeDay: (employeeId: number, date: string) => boolean;
  /** С реальным сигналом на своих днях — тот же критерий, что у zero_activity при утверждении. */
  activeIds: Set<number>;
}> {
  const ownedDays = new Map<number, Set<string>>(
    payload.employees.map(employee => [employee.identity.employee_id, new Set(Object.keys(employee.days))]),
  );
  const ownsEmployeeDay = (employeeId: number, date: string): boolean =>
    ownedDays.get(employeeId)?.has(date) ?? false;
  const employeeIds = [...ownedDays.keys()];

  const objectEntries: IAttendanceObjectEntry[] = [];
  const activeIds = new Set<number>();
  for (const anchor of monthAnchorsInRange(approval.start_date, approval.end_date)) {
    const monthEnd = lastDayOfMonth(anchor);
    const bulk = await fetchTimesheetDataForEmployees(
      anchor.slice(0, 7),
      employeeIds,
      'Объекты версии',
      {
        startDate: approval.start_date > anchor ? approval.start_date : anchor,
        endDate: approval.end_date < monthEnd ? approval.end_date : monthEnd,
      },
      'actual',
      true,
      { rosterMode: 'snapshot', exec: client },
    );
    for (const entry of bulk.entries) {
      if (ownsEmployeeDay(entry.employee_id, entry.work_date) && hasRealActivity(entry)) activeIds.add(entry.employee_id);
    }
    for (const entry of bulk.objectEntries) {
      if (!ownsEmployeeDay(entry.employee_id, entry.work_date)) continue;
      objectEntries.push(entry);
      activeIds.add(entry.employee_id);
    }
  }

  return { objectEntries, ownsEmployeeDay, activeIds };
}

/**
 * Объектная разбивка часов подачи.
 *
 * Считается ПОСЛЕ основного payload и от него же: целевые часы дня берутся из
 * payload.days, а объектные интервалы служат лишь весами. Иначе часы разошлись бы с
 * табелем — dataMap обнуляет несогласованный выходной, а objectEntries такого фильтра
 * не проходят.
 *
 * Все чтения — через тот же client: режим табелирования и адреса объектов обязаны быть
 * из того же снимка БД, что и часы.
 */
async function buildObjectsSnapshot(
  client: PoolClient,
  payload: ITimesheetVersionPayload,
  objectEntries: IAttendanceObjectEntry[],
  ownsEmployeeDay: (employeeId: number, date: string) => boolean,
  resolvedModes?: Map<number, IResolvedExportMode>,
): Promise<IVersionObjectsSnapshot & { modeByEmployee: Map<number, IResolvedExportMode> }> {
  // Режим — месяца подачи: для прошедшего месяца личный режим из фиксации (288).
  const { start_date: startDate, end_date: endDate } = payload.approval;
  if (startDate.slice(0, 7) !== endDate.slice(0, 7)) {
    throw new TimesheetVersionCrossMonthError(startDate, endDate);
  }
  const modeByEmployee = resolvedModes ?? await resolveExportModes(
    payload.employees.map(employee => employee.identity.employee_id), client, { month: startDate },
  );

  // Адреса нужны и фактическим объектам, и закреплённым в режиме «объект»: без второго
  // слагаемого у сотрудника без проходов адрес не нашёлся бы и строка уехала бы в
  // «Не определён» вместе с ложной ошибкой конфигурации.
  const objectIds = new Set<string>();
  for (const entry of objectEntries) {
    if (entry.object_id) objectIds.add(entry.object_id);
  }
  for (const resolved of modeByEmployee.values()) {
    if (resolved.mode === 'object' && resolved.pinnedObjectId) objectIds.add(resolved.pinnedObjectId);
  }

  const objectMetaById = new Map<string, IObjectMeta>();
  if (objectIds.size > 0) {
    const rows = (await client.query<{ id: string; alt_name: string | null; name: string }>(
      'SELECT id, alt_name, name FROM skud_objects WHERE id = ANY($1::uuid[])',
      [[...objectIds]],
    )).rows;
    for (const row of rows) {
      const altName = row.alt_name?.trim();
      objectMetaById.set(row.id, {
        name: row.name,
        address: altName && altName.length > 0 ? altName : row.name,
      });
    }
  }

  const built = buildVersionObjectBreakdown({
    employees: payload.employees.map(employee => ({
      employee_id: employee.identity.employee_id,
      full_name: employee.identity.full_name,
      days: employee.days,
    })),
    objectEntries,
    ownsDay: ownsEmployeeDay,
    modeByEmployee,
    objectMetaById,
  });

  return {
    payload: built.payload,
    hash: computeObjectsContentHash(built.payload, built.configErrors),
    configErrors: built.configErrors,
    employeesCount: built.employeesCount,
    totalHours: built.totalHours,
    modeByEmployee,
  };
}

/**
 * Руководители отдела для состава подачи.
 *
 * Отдел берётся из ТАБЕЛЯ, а не из текущей карточки сотрудника:
 *   - подача отдела  -> approval.department_id (авторитетно);
 *   - персональная   -> периоды отделов за диапазон подачи. Простой запрос к
 *     employee_assignments здесь не годится: он принял бы одиночный поздний
 *     effective_from от freeze-синхронизации за перевод и подставил не тот отдел.
 *
 * Все чтения — через тот же client: снимок обязан собираться из одного среза БД.
 */
async function buildManagersSnapshot(
  client: PoolClient,
  approval: IVersionApproval,
  payload: ITimesheetVersionPayload,
): Promise<IVersionManagersSnapshot> {
  const employees = payload.employees.map(employee => ({
    employee_id: employee.identity.employee_id,
    full_name: employee.identity.full_name,
  }));
  const employeeIds = employees.map(e => e.employee_id);

  const departmentByEmployee = new Map<number, IEmployeeDepartmentResolution>();
  if (approval.department_id) {
    for (const id of employeeIds) {
      departmentByEmployee.set(id, {
        department_id: approval.department_id,
        basis: 'approval_department',
      });
    }
  } else {
    const periods = await listEmployeeDepartmentPeriodsBulk(
      employeeIds, approval.start_date, approval.end_date, client,
    );
    for (const id of employeeIds) {
      const resolved = periods.get(id);
      departmentByEmployee.set(id, {
        department_id: resolved?.org_department_id ?? null,
        basis: 'employee_assignment_period',
        changedDuringPeriod: resolved?.changedDuringPeriod ?? false,
        usedSnapshotFallback: resolved?.usedSnapshotFallback ?? false,
      });
    }
  }

  const departmentIds = [...new Set(
    [...departmentByEmployee.values()].map(r => r.department_id).filter((id): id is string => Boolean(id)),
  )];
  const managersByDepartment = await listDepartmentManagers(departmentIds, client);

  const departmentNameById = new Map<string, string | null>();
  if (departmentIds.length > 0) {
    const rows = (await client.query<{ id: string; name: string | null }>(
      'SELECT id, name FROM org_departments WHERE id = ANY($1::uuid[])',
      [departmentIds],
    )).rows;
    for (const row of rows) departmentNameById.set(String(row.id), row.name ?? null);
  }

  const managerIds = [...new Set([...managersByDepartment.values()].flat())];
  const managerMetaById = new Map<number, IManagerMeta>();
  if (managerIds.length > 0) {
    // employees.id — BIGINT, поэтому bigint[].
    const rows = (await client.query<{
      id: string | number; full_name: string | null;
      employment_status: string | null; is_archived: boolean | null;
    }>(
      `SELECT id, full_name, employment_status, is_archived
         FROM employees WHERE id = ANY($1::bigint[])`,
      [managerIds],
    )).rows;
    for (const row of rows) {
      managerMetaById.set(Number(row.id), {
        full_name: row.full_name,
        employment_status: row.employment_status,
        is_archived: row.is_archived,
      });
    }
  }

  const built = buildVersionManagersSnapshot({
    employees,
    departmentByEmployee,
    managersByDepartment,
    departmentNameById,
    managerMetaById,
  });

  return {
    payload: built.payload,
    hash: computeManagersContentHash(built.payload),
    employeesCount: built.employeesCount,
    withoutManager: built.withoutManager,
  };
}

/**
 * Собирает канонический payload подачи.
 *
 * Состав — ТОЛЬКО из снимка timesheet_approval_employees, одинаково для подач отдела
 * и персональных: выгружается ровно тот ростер, который согласовали. Динамический
 * резолв по отделу здесь не используется — он нужен лишь для окон членства (дни).
 * Исключение — уволенные в месяце периода (с 01.09.2026, isFiredHiddenForPeriod): снимок
 * фиксируется при подаче, а увольнение может прийти позже, и в редакцию для 1С они не
 * попадают. Уволены все — редакция без сотрудников: 1С получит пустой документ вместо
 * устаревшего.
 */
export async function buildTimesheetPayload(
  client: PoolClient,
  approval: IVersionApproval,
): Promise<IBuiltVersion> {
  const snapshot = await listApprovalEmployees(approval.id, client);
  const rosterIds = snapshot.map(row => Number(row.employee_id)).filter(Number.isFinite);
  if (rosterIds.length === 0) throw new TimesheetVersionEmptyRosterError(approval.id);

  const tabRows = (await client.query<{
    id: number;
    tab_number: string | null;
    employment_status: string | null;
    // pg отдаёт DATE как Date; buildFiredCutoffMap принимает оба вида.
    dismissal_date: string | Date | null;
    excluded_from_timesheet_date: string | Date | null;
  }>(
    `SELECT id, tab_number, employment_status, dismissal_date, excluded_from_timesheet_date
       FROM employees WHERE id = ANY($1::int[])`,
    [rosterIds],
  )).rows;
  const tabById = new Map(tabRows.map(row => [Number(row.id), row.tab_number]));
  // До сбора часов: иначе проверка полноты сочла бы уволенного потерянным.
  const hiddenFiredIds = new Set(
    tabRows.filter(row => isFiredHiddenForPeriod(row, approval.start_date)).map(row => Number(row.id)),
  );
  const snapshotIds = rosterIds.filter(id => !hiddenFiredIds.has(id));

  const isPersonal = approval.manager_employee_id != null;
  const scopeKind: 'department' | 'personal' = isPersonal ? 'personal' : 'department';

  // Окна членства — только для ограничения дней внутри периода (перевод в середине).
  // Состав они не меняют ни при каких условиях.
  const membershipWindows: Record<string, IMembershipWindow> = {};
  if (!isPersonal && approval.department_id) {
    const memberships = await listEmployeeMembershipsForDepartmentPeriod(
      approval.department_id, approval.start_date, approval.end_date, client,
    );
    for (const row of memberships) {
      membershipWindows[String(row.employee_id)] = {
        joined_date: row.joined_date ?? null,
        transferred_out_date: row.transferred_out_date ?? null,
        joined_via_transfer: row.joined_via_transfer === true,
      };
    }
  }

  const departmentRows = approval.department_id
    ? (await client.query<{ name: string }>(
      'SELECT name FROM org_departments WHERE id = $1 LIMIT 1', [approval.department_id],
    )).rows
    : [];
  const departmentName = departmentRows[0]?.name ?? null;

  // Начальники участков остаются в выгрузке всегда — как строка «Начальник участка»
  // в Excel: им zero_activity проставляется false независимо от активности.
  const supervisorIds = approval.department_id
    ? await listBrigadeSupervisorEmployeeIdsForDepartments([approval.department_id], client)
    : new Set<number>();

  // Граница увольнения — та же формула, что в Excel-выгрузке для 1С (одна реализация,
  // иначе выгрузки разойдутся), и тот же гейт: карта строится ТОЛЬКО для
  // employment_status = 'fired'. По одному наличию dismissal_date отсекать нельзя —
  // при отложенном увольнении дата стоит у ещё действующего сотрудника, а редакция
  // неизменяема: срезанное не вернуть. Считаем один раз на весь период подачи, а не на
  // месячный чанк, — иначе граница поехала бы у подачи через стык месяцев.
  const firedCutoff = buildFiredCutoffMap(tabRows, approval.start_date);

  // Период может пересекать месяцы: сборщик работает помесячно, склеиваем результаты.
  const days = new Map<number, Record<string, IVersionDayValue>>();
  const activeIds = new Set<number>();
  // Копим по всем месяцам периода: объектная разбивка собирается один раз, после цикла.
  const allObjectEntries: IAttendanceObjectEntry[] = [];

  // Владение днём: подача забирает только те даты, на которые сотрудник числился
  // в её отделе. Иначе переведённый в середине периода уносит дни новой бригады в
  // выгрузку старой, и одна пара (сотрудник, дата) попадает в две версии для 1С.
  // Персональная подача симметрично отдаёт дни, на которые у сотрудника есть
  // действующий руководитель отдела: их выгружает подача отдела.
  const ownership = await resolveDayOwnership(
    snapshotIds.length > 0
      ? [{
        approvalId: approval.id,
        departmentId: approval.department_id,
        managerEmployeeId: approval.manager_employee_id ?? null,
        employeeIds: snapshotIds,
        dates: enumerateDatesInclusive(approval.start_date, approval.end_date),
      }]
      : [],
    client,
  );
  const ownsEmployeeDay = (employeeId: number, date: string): boolean =>
    ownsDay(ownership.get(ownershipKey(approval.id, employeeId, date)));

  /**
   * Пустой день после увольнения — тот, из-за которого 1С писала «сотрудник не оформлен
   * в ЗУП»: неявка с нулём часов у человека, которого в этот день уже нет в штате.
   *
   * Режем ТОЛЬКО такие. Полная отсечка по cutoff (как в Excel-выгрузке) выкинула бы и
   * реально отработанные дни: по срезу июль–август это 288 ч у пяти человек, уволенных
   * задним числом либо продолжавших ходить после даты увольнения. Редакция неизменяема,
   * поэтому терять часы нельзя — пусть 1С видит их и разбирается с кадрами.
   *
   * cutoff — дата ВКЛЮЧИТЕЛЬНО, с которой дни не считаются, поэтому сравнение нестрогое:
   * день увольнения остаётся в выгрузке при любом статусе.
   */
  const isBlankDayAfterDismissal = (
    employeeId: number, date: string, value: { status: string; hours?: unknown },
  ): boolean => {
    const cutoff = firedCutoff.get(employeeId);
    if (!cutoff || date < cutoff) return false;
    return value.status === 'absent' && !(typeof value.hours === 'number' && value.hours > 0);
  };
  const meta = new Map<number, { full_name: string | null; sigur_employee_id: number | null; position: string | null }>();
  const seenIds = new Set<number>();

  // Уволены все — собирать нечего, редакция будет без сотрудников.
  const anchors = snapshotIds.length > 0 ? monthAnchorsInRange(approval.start_date, approval.end_date) : [];
  for (const anchor of anchors) {
    const month = anchor.slice(0, 7);
    const monthStart = anchor;
    const monthEnd = lastDayOfMonth(anchor);
    const startDate = approval.start_date > monthStart ? approval.start_date : monthStart;
    const endDate = approval.end_date < monthEnd ? approval.end_date : monthEnd;

    const bulk = await fetchTimesheetDataForEmployees(
      month,
      snapshotIds,
      'Версия табеля',
      { startDate, endDate },
      'actual',
      true,
      // rosterMode: 'snapshot' отключает фильтр по статусу занятости — согласованный
      // состав выгружается целиком, включая архивных и уволенных задним числом.
      { rosterMode: 'snapshot', exec: client },
    );

    for (const employee of bulk.employees) {
      seenIds.add(employee.id);
      if (!meta.has(employee.id)) {
        meta.set(employee.id, {
          full_name: employee.full_name ?? null,
          sigur_employee_id: employee.sigur_employee_id ?? null,
          position: employee.position_id ? (bulk.posMap.get(employee.position_id) ?? null) : null,
        });
      }
    }

    // Активность — тоже только по своим дням: иначе у сотрудника с активностью
    // лишь после перевода дни в старой версии пустые, а zero_activity = false.
    for (const entry of bulk.entries) {
      if (!ownsEmployeeDay(entry.employee_id, entry.work_date)) continue;
      if (hasRealActivity(entry)) activeIds.add(entry.employee_id);
    }
    for (const objectEntry of bulk.objectEntries) {
      if (!ownsEmployeeDay(objectEntry.employee_id, objectEntry.work_date)) continue;
      activeIds.add(objectEntry.employee_id);
      allObjectEntries.push(objectEntry);
    }

    for (const [employeeId, dayMap] of bulk.dataMap) {
      const bucket = days.get(employeeId) ?? {};
      for (const [date, value] of dayMap) {
        if (!ownsEmployeeDay(employeeId, date)) continue;
        if (isBlankDayAfterDismissal(employeeId, date, value)) continue;
        bucket[date] = {
          status: value.status,
          hours: typeof value.hours === 'number' ? value.hours : 0,
          corrected: Boolean(value.corrected),
          hours_overridden: Boolean(value.hoursOverridden),
        };
      }
      days.set(employeeId, bucket);
    }
  }

  // Полнота обязательна: если кого-то из снимка расчёт не вернул, версии не будет.
  const missing = snapshotIds.filter(id => !seenIds.has(id));
  if (missing.length > 0) throw new TimesheetVersionIncompleteError(missing);

  // Режим — месяца подачи, один раз: нужен и zero_activity (назначенные в окне), и разбивке.
  const modeByEmployee = await resolveExportModes(snapshotIds, client, { month: approval.start_date });

  const employees: IVersionEmployee[] = [...snapshotIds]
    .sort((a, b) => a - b)
    .map(employeeId => {
      const dayMap = days.get(employeeId) ?? {};
      const total = Object.values(dayMap).reduce((sum, day) => sum + (day.hours || 0), 0);
      const info = meta.get(employeeId);
      const snapshotName = snapshot.find(row => Number(row.employee_id) === employeeId)?.full_name ?? null;
      return {
        identity: {
          employee_id: employeeId,
          sigur_employee_id: info?.sigur_employee_id ?? null,
          tab_number: tabById.get(employeeId) ?? null,
          full_name: info?.full_name ?? snapshotName,
        },
        position: info?.position ?? null,
        total_hours: Math.round(total * 100) / 100,
        zero_activity: isZeroActivity(employeeId, activeIds, supervisorIds, modeByEmployee),
        days: dayMap,
        object_rows: [],
      };
    });

  const totalHours = employees.reduce((sum, employee) => sum + employee.total_hours, 0);

  const payload: ITimesheetVersionPayload = {
    approval: {
      id: approval.id,
      scope: {
        kind: scopeKind,
        department_id: approval.department_id,
        department_name: departmentName,
        manager_employee_id: approval.manager_employee_id,
      },
      start_date: approval.start_date,
      end_date: approval.end_date,
      status: approval.status,
    },
    employees_count: employees.length,
    total_hours: Math.round(totalHours * 100) / 100,
    employees,
  };

  const objects = await buildObjectsSnapshot(client, payload, allObjectEntries, ownsEmployeeDay, modeByEmployee);
  const managers = await buildManagersSnapshot(client, approval, payload);

  return { payload, membershipWindows, objects, managers };
}

/** Записывает снимок объектной разбивки. Одна строка на редакцию (PK = version_id). */
export async function insertObjectsSnapshot(
  client: PoolClient,
  versionId: number,
  objects: IVersionObjectsSnapshot,
  source: 'materialize' | 'backfill',
): Promise<void> {
  await client.query(
    `INSERT INTO timesheet_version_objects (
       version_id, objects_content_hash, payload, employees_count, total_hours,
       config_errors, source
     ) VALUES ($1,$2,$3::jsonb,$4,$5,$6::jsonb,$7)
     ON CONFLICT (version_id) DO NOTHING`,
    [
      versionId,
      objects.hash,
      JSON.stringify(objects.payload),
      objects.employeesCount,
      objects.totalHours,
      JSON.stringify(objects.configErrors),
      source,
    ],
  );
}

/**
 * Собирает объектную разбивку для УЖЕ СОХРАНЁННОГО payload редакции.
 *
 * Путь бэкфилла: у редакций, закрытых до внедрения, снимка объектов нет. Пересобирать
 * ради этого сам табель нельзя — фоновый пересчёт СКУД мог уехать, и живой payload
 * разошёлся бы с официальным. Поэтому целевые часы берутся из сохранённого payload,
 * а живыми остаются только веса: объектные интервалы нигде не хранятся.
 */
export async function buildManagersSnapshotForVersion(
  client: PoolClient,
  approval: IVersionApproval,
  payload: ITimesheetVersionPayload,
): Promise<IVersionManagersSnapshot> {
  return buildManagersSnapshot(client, approval, payload);
}

export async function buildObjectsSnapshotForVersion(
  client: PoolClient,
  approval: IVersionApproval,
  payload: ITimesheetVersionPayload,
): Promise<IVersionObjectsSnapshot> {
  const { objectEntries, ownsEmployeeDay } = await collectOwnedObjectEntries(client, approval, payload);
  return buildObjectsSnapshot(client, payload, objectEntries, ownsEmployeeDay);
}

/** Записывает снимок руководителей. Одна строка на редакцию (PK = version_id). */
export async function insertManagersSnapshot(
  client: PoolClient,
  versionId: number,
  managers: IVersionManagersSnapshot,
  snapshotSource: 'materialize' | 'backfill_current_state',
): Promise<void> {
  await client.query(
    `INSERT INTO timesheet_version_managers (
       version_id, managers_content_hash, payload, employees_count, without_manager,
       snapshot_source, resolved_at
     ) VALUES ($1,$2,$3::jsonb,$4,$5,$6,NOW())
     ON CONFLICT (version_id) DO NOTHING`,
    [
      versionId,
      managers.hash,
      JSON.stringify(managers.payload),
      managers.employeesCount,
      managers.withoutManager,
      snapshotSource,
    ],
  );
}

/**
 * Создаёт версию подачи. Вызывать ТОЛЬКО когда строка timesheet_approvals уже
 * заблокирована SELECT ... FOR UPDATE в этой же транзакции — иначе гонка за revision.
 *
 * Если содержимое совпало с последней версией по content_hash, новая редакция не
 * создаётся: пустое открытие/закрытие не должно выглядеть как изменение.
 *
 * С объектной разбивкой правило шире — новая редакция нужна ещё в двух случаях:
 *
 *   1. objects_content_hash изменился при том же content_hash. Часы переставили между
 *      объектами, итог дня прежний: по одному лишь content_hash 1С об этом не узнала бы.
 *   2. у последней версии снимка объектов нет, и она УЖЕ подтверждена (ACK). Дописать
 *      снимок к ней нельзя: состояние выгрузки считается сравнением ack.version_id с
 *      текущим version_id, подача осталась бы exported и в needs_export не вернулась —
 *      а старый ACK выглядел бы подтверждением данных, которых на момент ACK не было.
 *
 * Если снимка нет, а версия ещё НЕ подтверждена, он дописывается на месте: это переход
 * после внедрения, и плодить редакции там незачем.
 */
export async function materializeVersion(
  client: PoolClient,
  approval: IVersionApproval,
  source: TimesheetVersionSource,
  actorUserId: string | null,
): Promise<{ version: ITimesheetVersionRow; created: boolean }> {
  const { payload, membershipWindows, objects, managers } = await buildTimesheetPayload(client, approval);
  const contentHash = computeContentHash(payload);

  const latest = (await client.query<ITimesheetVersionRow & {
    objects_content_hash: string | null;
    managers_content_hash: string | null;
    acked: boolean;
  }>(
    `SELECT v.id, v.approval_id, v.revision, v.content_hash, v.employees_count,
            v.total_hours, v.created_at,
            vo.objects_content_hash,
            vm.managers_content_hash,
            (ack.version_id IS NOT NULL) AS acked
       FROM timesheet_versions v
       LEFT JOIN timesheet_version_objects vo  ON vo.version_id = v.id
       LEFT JOIN timesheet_version_managers vm ON vm.version_id = v.id
       LEFT JOIN timesheet_1c_exports ack      ON ack.version_id = v.id
      WHERE v.approval_id = $1
      ORDER BY v.revision DESC
      LIMIT 1`,
    [approval.id],
  )).rows[0] ?? null;

  if (latest && latest.content_hash === contentHash) {
    const objectsSame = latest.objects_content_hash === objects.hash;
    const managersSame = latest.managers_content_hash === managers.hash;
    if (objectsSame && managersSame) {
      return { version: latest, created: false };
    }

    // Снимка ещё не было и редакцию 1С не подтверждала — дописываем на месте.
    // Дописать к ПОДТВЕРЖДЁННОЙ нельзя: состояние выгрузки считается сравнением
    // ack.version_id с текущим version_id, подача осталась бы exported, и 1С о новых
    // данных не узнала бы, а старый ACK выглядел бы подтверждением того, чего не было.
    const onlyMissingSnapshots =
      (objectsSame || latest.objects_content_hash === null)
      && (managersSame || latest.managers_content_hash === null);
    if (onlyMissingSnapshots && !latest.acked) {
      if (!objectsSame) await insertObjectsSnapshot(client, latest.id, objects, 'materialize');
      if (!managersSame) await insertManagersSnapshot(client, latest.id, managers, 'materialize');
      return { version: latest, created: false };
    }
    // Иначе — содержимое снимка изменилось либо редакция уже принята: нужна новая
    // revision с тем же payload, чтобы подача штатно стала stale.
  }

  const nextRevision = (latest?.revision ?? 0) + 1;
  const inserted = (await client.query<ITimesheetVersionRow>(
    `INSERT INTO timesheet_versions (
       approval_id, revision, content_hash, payload, scope_kind, department_id,
       manager_employee_id, start_date, end_date, employees_count, total_hours,
       membership_windows, source, created_by
     ) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14)
     RETURNING id, approval_id, revision, content_hash, employees_count, total_hours, created_at`,
    [
      approval.id,
      nextRevision,
      contentHash,
      JSON.stringify(payload),
      payload.approval.scope.kind,
      approval.department_id,
      approval.manager_employee_id,
      approval.start_date,
      approval.end_date,
      payload.employees_count,
      payload.total_hours,
      JSON.stringify(membershipWindows),
      source,
      actorUserId,
    ],
  )).rows[0]!;

  await insertObjectsSnapshot(client, inserted.id, objects, 'materialize');
  await insertManagersSnapshot(client, inserted.id, managers, 'materialize');

  return { version: inserted, created: true };
}

/**
 * Что определяет строку сотрудника в разбивке: режим и, для «объекта» и «Офиса», ключ
 * строки. Без часов строк нет, кроме назначенных в окне «Режим табелирования»: у них строка
 * с нулём часов — её появление или исчезновение тоже смена.
 */
function objectsPinIdentity(employee: IVersionObjectsEmployee): string {
  if (employee.mode === 'current_activity') return `current_activity:${employee.objects[0]?.object_key ?? ''}`;
  if (employee.mode !== 'object') return employee.mode;
  const pinned = employee.objects.find(row => row.object_key !== UNKNOWN_OBJECT_KEY)
    ?? employee.objects[0];
  return `object:${pinned?.object_key ?? ''}`;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * Сохранённая разбивка + свежая → разбивка, где заменены ТОЛЬКО сотрудники со сменой
 * режима или закреплённого объекта. Остальные строки остаются байт в байт: живые веса
 * СКУД могли уехать, и без этого редакция менялась бы не только из-за объекта.
 */
export function mergeObjectsSnapshots(
  stored: { payload: IVersionObjectsPayload; configErrors: IObjectConfigError[] },
  fresh: IVersionObjectsSnapshot,
  onlyEmployeeIds?: ReadonlySet<number>,
): IVersionObjectsSnapshot & { changedEmployeeIds: number[] } {
  const freshById = new Map(fresh.payload.employees.map(employee => [employee.employee_id, employee]));
  const changed = new Set<number>();

  const employees = stored.payload.employees.map(storedEmployee => {
    if (onlyEmployeeIds && !onlyEmployeeIds.has(storedEmployee.employee_id)) return storedEmployee;
    const freshEmployee = freshById.get(storedEmployee.employee_id);
    if (!freshEmployee) return storedEmployee;
    if (objectsPinIdentity(storedEmployee) === objectsPinIdentity(freshEmployee)) return storedEmployee;
    changed.add(storedEmployee.employee_id);
    return freshEmployee;
  });
  employees.sort((left, right) => left.employee_id - right.employee_id);

  const configErrors = [
    ...stored.configErrors.filter(error => !changed.has(error.employee_id)),
    ...fresh.configErrors.filter(error => changed.has(error.employee_id)),
  ].sort((left, right) => left.employee_id - right.employee_id || left.code.localeCompare(right.code));

  const payload: IVersionObjectsPayload = { employees };
  return {
    payload,
    hash: computeObjectsContentHash(payload, configErrors),
    configErrors,
    employeesCount: employees.length,
    totalHours: round2(employees.reduce((sum, employee) => sum + employee.total_hours, 0)),
    changedEmployeeIds: [...changed].sort((a, b) => a - b),
  };
}

/**
 * Новая редакция «только объекты» (миграция 288): после фиксации месяца подача,
 * закрытая раньше (1–15 число), получает объектную разбивку по зафиксированному
 * объекту; после записи в окне «Режим табелирования» (291) — сразу, по живому режиму.
 * Часы не пересчитываются. Payload и content_hash прежние, кроме zero_activity назначенных
 * в окне: им то же правило, что при утверждении (isZeroActivity) — назначенный уходит в 1С
 * и при всех «Н». Снимок руководителей переносится из предыдущей редакции как есть.
 *
 * onlyEmployeeIds — разбивка и zero_activity меняются только у этих сотрудников (запись в
 * окне); без него — у всех со сменой объекта, а zero_activity — у назначенных в окне. Остальные
 * строки payload и разбивки — байт в байт: поздние события СКУД чужие строки не переключают.
 *
 * Вызывать под блокировкой подачи (SELECT … FOR UPDATE в той же транзакции), как
 * materializeVersion. Повтор — no-op: оба хэша совпадут.
 */
export async function rebuildVersionObjects(
  client: PoolClient,
  approval: IVersionApproval,
  actorUserId: string | null,
  options: { onlyEmployeeIds?: readonly number[] } = {},
): Promise<{ created: boolean; revision: number | null; changedEmployeeIds: number[] }> {
  const latest = (await client.query<{
    id: number;
    revision: number;
    content_hash: string;
    payload: ITimesheetVersionPayload;
    scope_kind: string;
    employees_count: number;
    total_hours: number;
    membership_windows: unknown;
    objects_content_hash: string | null;
    objects_payload: IVersionObjectsPayload | null;
    config_errors: IObjectConfigError[] | null;
  }>(
    `SELECT v.id, v.revision, v.content_hash, v.payload, v.scope_kind,
            v.employees_count, v.total_hours, v.membership_windows,
            vo.objects_content_hash,
            vo.payload       AS objects_payload,
            vo.config_errors
       FROM timesheet_versions v
       LEFT JOIN timesheet_version_objects vo ON vo.version_id = v.id
      WHERE v.approval_id = $1
      ORDER BY v.revision DESC
      LIMIT 1`,
    [approval.id],
  )).rows[0];

  // Редакции без снимка объектов — забота бэкфилла, не этой пересборки.
  if (!latest || latest.objects_content_hash == null || !latest.objects_payload) {
    return { created: false, revision: null, changedEmployeeIds: [] };
  }

  const only = options.onlyEmployeeIds ? new Set(options.onlyEmployeeIds) : undefined;
  const { objectEntries, ownsEmployeeDay, activeIds } = await collectOwnedObjectEntries(client, approval, latest.payload);
  const fresh = await buildObjectsSnapshot(client, latest.payload, objectEntries, ownsEmployeeDay);
  const merged = mergeObjectsSnapshots(
    {
      payload: latest.objects_payload,
      configErrors: Array.isArray(latest.config_errors) ? latest.config_errors : [],
    },
    fresh,
    only,
  );
  const objectsChanged = merged.changedEmployeeIds.length > 0 && merged.hash !== latest.objects_content_hash;

  const zeroCandidates = only ?? new Set(
    [...fresh.modeByEmployee].filter(([, resolved]) => resolved.windowPin).map(([id]) => id),
  );
  const supervisorIds = zeroCandidates.size > 0 && approval.department_id
    ? await listBrigadeSupervisorEmployeeIdsForDepartments([approval.department_id], client)
    : new Set<number>();
  const zeroChanged: number[] = [];
  const employees = latest.payload.employees.map(employee => {
    const employeeId = employee.identity.employee_id;
    if (!zeroCandidates.has(employeeId)) return employee;
    const zeroActivity = isZeroActivity(employeeId, activeIds, supervisorIds, fresh.modeByEmployee);
    if (zeroActivity === employee.zero_activity) return employee;
    zeroChanged.push(employeeId);
    return { ...employee, zero_activity: zeroActivity };
  });
  const payload = zeroChanged.length > 0 ? { ...latest.payload, employees } : latest.payload;
  const contentHash = zeroChanged.length > 0 ? computeContentHash(payload) : latest.content_hash;

  if (!objectsChanged && contentHash === latest.content_hash) {
    return { created: false, revision: null, changedEmployeeIds: [] };
  }

  const nextRevision = Number(latest.revision) + 1;
  const inserted = (await client.query<{ id: number }>(
    `INSERT INTO timesheet_versions (
       approval_id, revision, content_hash, payload, scope_kind, department_id,
       manager_employee_id, start_date, end_date, employees_count, total_hours,
       membership_windows, source, created_by
     ) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,'objects',$13)
     RETURNING id`,
    [
      approval.id,
      nextRevision,
      contentHash,
      JSON.stringify(payload),
      latest.scope_kind,
      approval.department_id,
      approval.manager_employee_id,
      approval.start_date,
      approval.end_date,
      latest.employees_count,
      latest.total_hours,
      JSON.stringify(latest.membership_windows ?? {}),
      actorUserId,
    ],
  )).rows[0]!;

  await insertObjectsSnapshot(client, inserted.id, merged, 'materialize');
  await client.query(
    `INSERT INTO timesheet_version_managers (
       version_id, managers_content_hash, payload, employees_count, without_manager,
       snapshot_source, resolved_at
     )
     SELECT $1, managers_content_hash, payload, employees_count, without_manager,
            snapshot_source, resolved_at
       FROM timesheet_version_managers
      WHERE version_id = $2
     ON CONFLICT (version_id) DO NOTHING`,
    [inserted.id, latest.id],
  );

  const changedEmployeeIds = [...new Set([...merged.changedEmployeeIds, ...zeroChanged])].sort((a, b) => a - b);
  return { created: true, revision: nextRevision, changedEmployeeIds };
}

/** Сохранённая редакция со снимками — вход адресного удаления сотрудников. */
export interface IStoredVersionSnapshots {
  payload: ITimesheetVersionPayload;
  membershipWindows: Record<string, unknown>;
  objects: { payload: IVersionObjectsPayload; configErrors: IObjectConfigError[] } | null;
  managers: { payload: IVersionManagersPayload } | null;
}

export interface IVersionWithoutEmployees {
  /** Кого реально убрали (были в payload), по возрастанию id. */
  removedIds: number[];
  payload: ITimesheetVersionPayload;
  contentHash: string;
  membershipWindows: Record<string, unknown>;
  objects: IVersionObjectsSnapshot | null;
  managers: IVersionManagersSnapshot | null;
}

/**
 * Редакция без указанных сотрудников — чистая функция. Остальные сотрудники, их дни,
 * объектная разбивка и руководители берутся из сохранённой редакции байт в байт;
 * пересчитываются только итоги и хэши. Нужна разовой пересборке подач без уволенных:
 * materializeVersion заново посчитал бы и разбивку, и руководителей, и окна членства.
 */
export function removeEmployeesFromVersion(
  stored: IStoredVersionSnapshots,
  removeIds: ReadonlySet<number>,
): IVersionWithoutEmployees {
  const keep = (employeeId: number): boolean => !removeIds.has(Number(employeeId));
  const removedIds = stored.payload.employees
    .map(employee => Number(employee.identity.employee_id))
    .filter(id => removeIds.has(id))
    .sort((a, b) => a - b);

  const employees = stored.payload.employees.filter(employee => keep(employee.identity.employee_id));
  const payload: ITimesheetVersionPayload = {
    ...stored.payload,
    employees_count: employees.length,
    total_hours: round2(employees.reduce((sum, employee) => sum + employee.total_hours, 0)),
    employees,
  };

  const membershipWindows = Object.fromEntries(
    Object.entries(stored.membershipWindows).filter(([employeeId]) => keep(Number(employeeId))),
  );

  let objects: IVersionObjectsSnapshot | null = null;
  if (stored.objects) {
    const objectEmployees = stored.objects.payload.employees.filter(employee => keep(employee.employee_id));
    const objectsPayload: IVersionObjectsPayload = { ...stored.objects.payload, employees: objectEmployees };
    const configErrors = stored.objects.configErrors.filter(error => keep(error.employee_id));
    objects = {
      payload: objectsPayload,
      hash: computeObjectsContentHash(objectsPayload, configErrors),
      configErrors,
      employeesCount: objectEmployees.length,
      totalHours: round2(objectEmployees.reduce((sum, employee) => sum + employee.total_hours, 0)),
    };
  }

  let managers: IVersionManagersSnapshot | null = null;
  if (stored.managers) {
    const managerEmployees = stored.managers.payload.employees.filter(employee => keep(employee.employee_id));
    const managersPayload: IVersionManagersPayload = { ...stored.managers.payload, employees: managerEmployees };
    managers = {
      payload: managersPayload,
      hash: computeManagersContentHash(managersPayload),
      employeesCount: managerEmployees.length,
      withoutManager: managerEmployees.filter(employee => employee.managers.length === 0).length,
    };
  }

  return { removedIds, payload, contentHash: computeContentHash(payload), membershipWindows, objects, managers };
}

/**
 * Новая редакция подачи без указанных сотрудников (removeEmployeesFromVersion): revision + 1,
 * source 'rebuild'. Вызывать под теми же локами и FOR UPDATE подачи, что утверждение.
 * Убирать некого — редакция не создаётся.
 */
export async function rebuildVersionWithoutEmployees(
  client: PoolClient,
  approval: IVersionApproval,
  removeIds: ReadonlySet<number>,
): Promise<{ created: boolean; revision: number | null; removedIds: number[] }> {
  const latest = (await client.query<{
    id: number;
    revision: number;
    payload: ITimesheetVersionPayload;
    scope_kind: string;
    membership_windows: Record<string, unknown> | null;
    objects_payload: IVersionObjectsPayload | null;
    config_errors: IObjectConfigError[] | null;
    managers_payload: IVersionManagersPayload | null;
  }>(
    `SELECT v.id, v.revision, v.payload, v.scope_kind, v.membership_windows,
            vo.payload       AS objects_payload,
            vo.config_errors,
            vm.payload       AS managers_payload
       FROM timesheet_versions v
       LEFT JOIN timesheet_version_objects vo  ON vo.version_id = v.id
       LEFT JOIN timesheet_version_managers vm ON vm.version_id = v.id
      WHERE v.approval_id = $1
      ORDER BY v.revision DESC
      LIMIT 1`,
    [approval.id],
  )).rows[0];
  if (!latest) return { created: false, revision: null, removedIds: [] };

  const built = removeEmployeesFromVersion({
    payload: latest.payload,
    membershipWindows: latest.membership_windows ?? {},
    objects: latest.objects_payload
      ? { payload: latest.objects_payload, configErrors: Array.isArray(latest.config_errors) ? latest.config_errors : [] }
      : null,
    managers: latest.managers_payload ? { payload: latest.managers_payload } : null,
  }, removeIds);
  if (built.removedIds.length === 0) return { created: false, revision: null, removedIds: [] };

  const nextRevision = Number(latest.revision) + 1;
  const inserted = (await client.query<{ id: number }>(
    `INSERT INTO timesheet_versions (
       approval_id, revision, content_hash, payload, scope_kind, department_id,
       manager_employee_id, start_date, end_date, employees_count, total_hours,
       membership_windows, source, created_by
     ) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,'rebuild',NULL)
     RETURNING id`,
    [
      approval.id,
      nextRevision,
      built.contentHash,
      JSON.stringify(built.payload),
      latest.scope_kind,
      approval.department_id,
      approval.manager_employee_id,
      approval.start_date,
      approval.end_date,
      built.payload.employees_count,
      built.payload.total_hours,
      JSON.stringify(built.membershipWindows),
    ],
  )).rows[0]!;

  if (built.objects) await insertObjectsSnapshot(client, inserted.id, built.objects, 'materialize');
  if (built.managers) {
    // Источник и время резолва руководителей — от прежней редакции: состав руководителей не пересчитан.
    await client.query(
      `INSERT INTO timesheet_version_managers (
         version_id, managers_content_hash, payload, employees_count, without_manager,
         snapshot_source, resolved_at
       )
       SELECT $1, $2, $3::jsonb, $4, $5, snapshot_source, resolved_at
         FROM timesheet_version_managers
        WHERE version_id = $6
       ON CONFLICT (version_id) DO NOTHING`,
      [
        inserted.id,
        built.managers.hash,
        JSON.stringify(built.managers.payload),
        built.managers.employeesCount,
        built.managers.withoutManager,
        latest.id,
      ],
    );
  }

  return { created: true, revision: nextRevision, removedIds: built.removedIds };
}

/**
 * Замки закрытого периода для записи в табель.
 *
 * Единая точка для всех транзакционных путей записи. Раньше проверка была размазана
 * по нескольким функциям, и часть путей прошла бы мимо неё.
 *
 * ПРИВИЛЕГИЙ НЕТ НИ У КОГО, включая is_admin. Закрытый согласованный табель правится
 * только через «Открыть табель → правки → Закрыть табель»: тогда новая официальная
 * редакция для 1С создаётся ровно в одной точке — в момент закрытия. Раньше здесь была
 * ветка для админа, которая пропускала запись и помечала версию на фоновую пересборку;
 * она убрана вместе с самой возможностью писать в закрытый период напрямую.
 *
 * Выборка идёт по submitted И approved: если брать только approved, правки поедут
 * в табели, отправленные на проверку.
 *
 * Вызывать ВНУТРИ транзакции записи, под уже взятым advisory-локом (сотрудник, месяц):
 * иначе закрытие успевает вклиниться между проверкой и записью.
 */
export async function loadClosedTimesheetLocks(
  pairs: readonly ITimesheetLockPair[],
  exec: DbExecutor,
): Promise<Map<string, IApprovalLockInfo>> {
  return findApprovalLocksForEmployeeDates(pairs, exec);
}

/**
 * Снимает метку — штатные approve/close уже включили изменения в свежую версию,
 * пересобирать нечего. Вызывается в той же транзакции, что и материализация.
 */
export async function clearVersionDirty(exec: DbExecutor, approvalId: number): Promise<void> {
  await exec.query(
    `UPDATE timesheet_approvals
        SET version_dirty_at = NULL,
            version_rebuild_attempts = 0,
            version_rebuild_after = NULL,
            version_rebuild_last_error = NULL
      WHERE id = $1`,
    [approvalId],
  );
}

/** Состояние выгрузки: сверяем последнюю версию с последним подтверждением. */
export function resolveState(
  latestVersionId: number | null,
  ackedVersionId: number | null,
): TimesheetExportState {
  if (latestVersionId == null) return 'not_exported';
  if (ackedVersionId == null) return 'not_exported';
  return ackedVersionId === latestVersionId ? 'exported' : 'stale';
}
