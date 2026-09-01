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
import { fetchTimesheetDataForEmployees } from './timesheet-export.service.js';
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
  /** Зарезервировано под объектную разбивку; сейчас всегда пусто. */
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
function monthAnchorsInRange(startDate: string, endDate: string): string[] {
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
 * Каноническая сериализация: ключи объектов сортируются лексикографически,
 * массивы сохраняют свой порядок (employees заранее отсортированы по employee_id).
 * Без этого хэш «плавал» бы от порядка вставки ключей в JS-объект.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = canonicalize(source[key]);
    return out;
  }
  return value;
}

/**
 * md5 всего фактического payload — включая identity, zero_activity, object_rows и итоги.
 * Хэшируется именно то, что уходит в 1С: смена табельного номера, состава или одного
 * флага zero_activity обязана менять хэш.
 */
export function computeContentHash(payload: ITimesheetVersionPayload): string {
  return crypto.createHash('md5').update(JSON.stringify(canonicalize(payload))).digest('hex');
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
 * Собирает канонический payload подачи.
 *
 * Состав — ТОЛЬКО из снимка timesheet_approval_employees, одинаково для подач отдела
 * и персональных: выгружается ровно тот ростер, который согласовали. Динамический
 * резолв по отделу здесь не используется — он нужен лишь для окон членства (дни).
 */
export async function buildTimesheetPayload(
  client: PoolClient,
  approval: IVersionApproval,
): Promise<{ payload: ITimesheetVersionPayload; membershipWindows: Record<string, IMembershipWindow> }> {
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

  return {
    payload: {
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
    },
    membershipWindows,
  };
}

/**
 * Создаёт версию подачи. Вызывать ТОЛЬКО когда строка timesheet_approvals уже
 * заблокирована SELECT ... FOR UPDATE в этой же транзакции — иначе гонка за revision.
 *
 * Если содержимое совпало с последней версией по content_hash, новая редакция не
 * создаётся: пустое открытие/закрытие не должно выглядеть как изменение.
 */
export async function materializeVersion(
  client: PoolClient,
  approval: IVersionApproval,
  source: TimesheetVersionSource,
  actorUserId: string | null,
): Promise<{ version: ITimesheetVersionRow; created: boolean }> {
  const { payload, membershipWindows } = await buildTimesheetPayload(client, approval);
  const contentHash = computeContentHash(payload);

  const latest = (await client.query<ITimesheetVersionRow>(
    `SELECT id, approval_id, revision, content_hash, employees_count, total_hours, created_at
       FROM timesheet_versions
      WHERE approval_id = $1
      ORDER BY revision DESC
      LIMIT 1`,
    [approval.id],
  )).rows[0] ?? null;

  if (latest && latest.content_hash === contentHash) {
    return { version: latest, created: false };
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
  )).rows[0];

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
