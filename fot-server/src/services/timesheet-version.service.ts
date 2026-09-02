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
import { resolveExportModes } from './timesheet-export-mode.service.js';
import {
  buildVersionObjectBreakdown,
  computeObjectsContentHash,
  type IObjectConfigError,
  type IObjectMeta,
  type IVersionObjectsPayload,
} from './timesheet-object-breakdown.service.js';
import type { IAttendanceObjectEntry } from './timesheet-object.service.js';
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
export type TimesheetVersionSource = 'approve' | 'close' | 'backfill' | 'rebuild';
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
  /** true — за период нет ни одного реального сигнала; 1С такие строки не переносит. */
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

/** Снимок объектной разбивки, собранный вместе с версией. */
export interface IVersionObjectsSnapshot {
  payload: IVersionObjectsPayload;
  hash: string;
  configErrors: IObjectConfigError[];
  employeesCount: number;
  totalHours: number;
}

export interface IBuiltVersion {
  payload: ITimesheetVersionPayload;
  membershipWindows: Record<string, IMembershipWindow>;
  objects: IVersionObjectsSnapshot;
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
 * Объектные интервалы подачи, отфильтрованные правилом владения днём.
 *
 * Владение обязано быть тем же, что у основного payload: иначе переведённый в середине
 * периода унёс бы объектные часы новой бригады в выгрузку старой.
 */
async function collectOwnedObjectEntries(
  client: PoolClient,
  approval: IVersionApproval,
  employeeIds: number[],
): Promise<{
  objectEntries: IAttendanceObjectEntry[];
  ownsEmployeeDay: (employeeId: number, date: string) => boolean;
}> {
  const ownership = await resolveDayOwnership(
    [{
      approvalId: approval.id,
      departmentId: approval.department_id,
      employeeIds,
      dates: enumerateDatesInclusive(approval.start_date, approval.end_date),
    }],
    client,
  );
  const ownsEmployeeDay = (employeeId: number, date: string): boolean =>
    ownsDay(ownership.get(ownershipKey(approval.id, employeeId, date)));

  const objectEntries: IAttendanceObjectEntry[] = [];
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
    for (const entry of bulk.objectEntries) {
      if (!ownsEmployeeDay(entry.employee_id, entry.work_date)) continue;
      objectEntries.push(entry);
    }
  }

  return { objectEntries, ownsEmployeeDay };
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
): Promise<IVersionObjectsSnapshot> {
  const employeeIds = payload.employees.map(employee => employee.identity.employee_id);
  const modeByEmployee = await resolveExportModes(employeeIds, client);

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
  };
}

/**
 * Собирает канонический payload подачи.
 *
 * Состав — ТОЛЬКО из снимка timesheet_approval_employees, одинаково для подач отдела
 * и персональных: выгружается ровно тот ростер, который согласовали. Динамический
 * резолв по отделу здесь не используется — он нужен лишь для окон членства (дни).
 */
export async function buildTimesheetPayload(
  client: PoolClient,
  approval: IVersionApproval,
): Promise<IBuiltVersion> {
  const snapshot = await listApprovalEmployees(approval.id, client);
  const snapshotIds = snapshot.map(row => Number(row.employee_id)).filter(Number.isFinite);
  if (snapshotIds.length === 0) throw new TimesheetVersionEmptyRosterError(approval.id);

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

  const tabRows = (await client.query<{ id: number; tab_number: string | null }>(
    'SELECT id, tab_number FROM employees WHERE id = ANY($1::int[])', [snapshotIds],
  )).rows;
  const tabById = new Map(tabRows.map(row => [Number(row.id), row.tab_number]));

  // Период может пересекать месяцы: сборщик работает помесячно, склеиваем результаты.
  const days = new Map<number, Record<string, IVersionDayValue>>();
  const activeIds = new Set<number>();
  // Копим по всем месяцам периода: объектная разбивка собирается один раз, после цикла.
  const allObjectEntries: IAttendanceObjectEntry[] = [];

  // Владение днём: подача забирает только те даты, на которые сотрудник числился
  // в её отделе. Иначе переведённый в середине периода уносит дни новой бригады в
  // выгрузку старой, и одна пара (сотрудник, дата) попадает в две версии для 1С.
  // Для персональной подачи резолвер отдаёт unknown — владение остаётся снимочным.
  const ownership = await resolveDayOwnership(
    [{
      approvalId: approval.id,
      departmentId: approval.department_id,
      employeeIds: snapshotIds,
      dates: enumerateDatesInclusive(approval.start_date, approval.end_date),
    }],
    client,
  );
  const ownsEmployeeDay = (employeeId: number, date: string): boolean =>
    ownsDay(ownership.get(ownershipKey(approval.id, employeeId, date)));
  const meta = new Map<number, { full_name: string | null; sigur_employee_id: number | null; position: string | null }>();
  const seenIds = new Set<number>();

  for (const anchor of monthAnchorsInRange(approval.start_date, approval.end_date)) {
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
        zero_activity: !activeIds.has(employeeId) && !supervisorIds.has(employeeId),
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

  const objects = await buildObjectsSnapshot(client, payload, allObjectEntries, ownsEmployeeDay);

  return { payload, membershipWindows, objects };
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
export async function buildObjectsSnapshotForVersion(
  client: PoolClient,
  approval: IVersionApproval,
  payload: ITimesheetVersionPayload,
): Promise<IVersionObjectsSnapshot> {
  const employeeIds = payload.employees.map(employee => employee.identity.employee_id);
  const { objectEntries, ownsEmployeeDay } = await collectOwnedObjectEntries(
    client, approval, employeeIds,
  );
  return buildObjectsSnapshot(client, payload, objectEntries, ownsEmployeeDay);
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
  const { payload, membershipWindows, objects } = await buildTimesheetPayload(client, approval);
  const contentHash = computeContentHash(payload);

  const latest = (await client.query<ITimesheetVersionRow & {
    objects_content_hash: string | null;
    acked: boolean;
  }>(
    `SELECT v.id, v.approval_id, v.revision, v.content_hash, v.employees_count,
            v.total_hours, v.created_at,
            vo.objects_content_hash,
            (ack.version_id IS NOT NULL) AS acked
       FROM timesheet_versions v
       LEFT JOIN timesheet_version_objects vo ON vo.version_id = v.id
       LEFT JOIN timesheet_1c_exports ack     ON ack.version_id = v.id
      WHERE v.approval_id = $1
      ORDER BY v.revision DESC
      LIMIT 1`,
    [approval.id],
  )).rows[0] ?? null;

  if (latest && latest.content_hash === contentHash) {
    if (latest.objects_content_hash === objects.hash) {
      return { version: latest, created: false };
    }
    if (latest.objects_content_hash === null && !latest.acked) {
      await insertObjectsSnapshot(client, latest.id, objects, 'materialize');
      return { version: latest, created: false };
    }
    // Иначе — разбивка изменилась либо редакция уже принята: нужна новая revision
    // с тем же payload, чтобы подача штатно стала stale.
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

  return { version: inserted, created: true };
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
