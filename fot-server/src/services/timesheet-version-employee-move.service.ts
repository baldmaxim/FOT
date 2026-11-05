/**
 * Разовый перенос сотрудников между закрытыми подачами одного периода — после ручной правки
 * назначений в обход приложения.
 *
 * Сотрудник с ошибочным назначением лежит в подачах двух отделов: в верной строка пустая
 * (день ей не принадлежал, см. timesheet-day-ownership.service), часы — в ошибочной. Когда
 * назначения исправлены, его строка переезжает из редакции ошибочной подачи в редакцию верной,
 * как есть, с объектной разбивкой и основой зарплаты. Остальные сотрудники обеих подач — байт
 * в байт: штатная пересборка (materializeVersion) заново посчитала бы всех по текущим правилам.
 *
 * Все пары — одна транзакция под локами утверждения: при любом отказе не применяется ничего.
 * У пары, которую кадры уже пересобрали после правки назначений, новых редакций не будет.
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { query } from '../config/postgres.js';
import { canonicalJson } from '../utils/canonical-json.js';
import { AUDIT_ACTIONS, auditService } from './audit.service.js';
import { copyPayrollBasis, copyPayrollBasisOfEmployees } from './payroll/payroll-basis.service.js';
import {
  enumerateDatesInclusive,
  ownershipKey,
  resolveDayOwnership,
} from './timesheet-day-ownership.service.js';
import type { IVersionManagersPayload } from './timesheet-managers-snapshot.service.js';
import {
  computeObjectsContentHash,
  type IObjectConfigError,
  type IVersionObjectsPayload,
} from './timesheet-object-breakdown.service.js';
import { withTimesheetSnapshotTransaction } from './timesheet-snapshot-tx.js';
import { isRebuildableApproval } from './timesheet-version-objects-rebuild.service.js';
import {
  computeContentHash,
  insertObjectsSnapshot,
  monthAnchorsInRange,
  rebuildVersionWithoutEmployees,
  removeEmployeesFromVersion,
  type IStoredVersionSnapshots,
  type ITimesheetVersionPayload,
  type IVersionObjectsSnapshot,
  type IVersionWithoutEmployees,
} from './timesheet-version.service.js';

export class EmployeeMoveRefusedError extends Error {}

export interface IEmployeeMoveRequest {
  fromApprovalId: number;
  toApprovalId: number;
  employeeIds: readonly number[];
}

/** move — строки ещё в источнике; already_moved — они уже в цели с днями, делать нечего. */
export type TEmployeeMovePairState = 'move' | 'already_moved';

export interface IEmployeeMoveSide {
  approvalId: number;
  departmentName: string | null;
  revision: number;
  versionId: number;
  employeesBefore: number;
  employeesAfter: number;
  hoursBefore: number;
  hoursAfter: number;
}

export interface IEmployeeMovePlan {
  state: TEmployeeMovePairState;
  startDate: string;
  endDate: string;
  /** Их строки: при move — из источника, при already_moved — из цели. */
  employees: Array<{ employeeId: number; fullName: string | null; hours: number; days: number }>;
  from: IEmployeeMoveSide;
  to: IEmployeeMoveSide;
}

export interface IEmployeeMovePairResult {
  fromApprovalId: number;
  toApprovalId: number;
  fromRevision: number;
  toRevision: number;
  movedIds: number[];
}

export interface IEmployeeMoveResult {
  runId: string;
  /** Только реально перенесённые пары; already_moved сюда не попадают. */
  pairs: IEmployeeMovePairResult[];
}

export interface IVersionWithMovedEmployees {
  movedIds: number[];
  payload: ITimesheetVersionPayload;
  contentHash: string;
  objects: IVersionObjectsSnapshot | null;
}

interface IApprovalRow {
  id: number | string;
  department_id: string | null;
  manager_employee_id: number | string | null;
  start_date: string;
  end_date: string;
  status: string;
  unlocked_at: string | null;
  version_dirty_at: string | null;
}

interface ILatestVersionRow {
  id: number | string;
  revision: number;
  payload: ITimesheetVersionPayload;
  scope_kind: string;
  membership_windows: Record<string, unknown> | null;
  objects_payload: IVersionObjectsPayload | null;
  config_errors: IObjectConfigError[] | null;
  managers_payload: IVersionManagersPayload | null;
  acks: number | string;
}

interface IBuiltMoveBase {
  from: IApprovalRow;
  to: IApprovalRow;
  fromLatest: ILatestVersionRow;
  toLatest: ILatestVersionRow;
  employeeIds: number[];
}

interface IBuiltPendingMove extends IBuiltMoveBase {
  state: 'move';
  withoutMoved: IVersionWithoutEmployees;
  merged: IVersionWithMovedEmployees;
}

interface IBuiltDoneMove extends IBuiltMoveBase {
  state: 'already_moved';
}

type TBuiltMove = IBuiltPendingMove | IBuiltDoneMove;

const round2 = (value: number): number => Math.round(value * 100) / 100;

const dayCount = (employee: ITimesheetVersionPayload['employees'][number]): number =>
  Object.keys(employee.days ?? {}).length;

const toStored = (latest: ILatestVersionRow): IStoredVersionSnapshots => ({
  payload: latest.payload,
  membershipWindows: latest.membership_windows ?? {},
  objects: latest.objects_payload
    ? { payload: latest.objects_payload, configErrors: Array.isArray(latest.config_errors) ? latest.config_errors : [] }
    : null,
  managers: latest.managers_payload ? { payload: latest.managers_payload } : null,
});

/**
 * Редакция с перенесёнными сотрудниками — чистая функция. Строка и объектная разбивка каждого
 * берутся из источника как есть и встают на место его пустой строки; остальные — байт в байт,
 * пересчитываются только итоги и хэши. Руководители и окна членства остаются от целевой подачи.
 * Непустая строка в цели — отказ: иначе дни перезаписались бы или задвоились.
 */
export function mergeEmployeesIntoVersion(
  target: IStoredVersionSnapshots,
  source: IStoredVersionSnapshots,
  moveIds: ReadonlySet<number>,
): IVersionWithMovedEmployees {
  const sourceRows = new Map(source.payload.employees
    .filter(employee => moveIds.has(Number(employee.identity.employee_id)))
    .map(employee => [Number(employee.identity.employee_id), employee]));
  const targetRows = new Map(target.payload.employees.map(employee => [Number(employee.identity.employee_id), employee]));

  for (const employeeId of moveIds) {
    if (!sourceRows.has(employeeId)) throw new EmployeeMoveRefusedError(`сотрудника ${employeeId} нет в подаче-источнике`);
    const targetRow = targetRows.get(employeeId);
    if (!targetRow) throw new EmployeeMoveRefusedError(`сотрудника ${employeeId} нет в целевой подаче`);
    if (dayCount(targetRow) > 0 || targetRow.total_hours !== 0) {
      throw new EmployeeMoveRefusedError(`в целевой подаче у сотрудника ${employeeId} уже есть дни или часы`);
    }
  }

  const employees = target.payload.employees.map(
    employee => sourceRows.get(Number(employee.identity.employee_id)) ?? employee,
  );
  const payload: ITimesheetVersionPayload = {
    ...target.payload,
    employees_count: employees.length,
    total_hours: round2(employees.reduce((sum, employee) => sum + employee.total_hours, 0)),
    employees,
  };

  if (Boolean(target.objects) !== Boolean(source.objects)) {
    throw new EmployeeMoveRefusedError('объектная разбивка есть только у одной из подач');
  }
  let objects: IVersionObjectsSnapshot | null = null;
  if (target.objects && source.objects) {
    const sourceObjectRows = new Map(source.objects.payload.employees
      .filter(employee => moveIds.has(Number(employee.employee_id)))
      .map(employee => [Number(employee.employee_id), employee]));
    const targetObjectIds = new Set(target.objects.payload.employees.map(employee => Number(employee.employee_id)));
    for (const employeeId of moveIds) {
      if (!sourceObjectRows.has(employeeId) || !targetObjectIds.has(employeeId)) {
        throw new EmployeeMoveRefusedError(`у сотрудника ${employeeId} нет строки объектной разбивки в одной из подач`);
      }
    }
    const objectEmployees = target.objects.payload.employees.map(
      employee => sourceObjectRows.get(Number(employee.employee_id)) ?? employee,
    );
    const objectsPayload: IVersionObjectsPayload = { ...target.objects.payload, employees: objectEmployees };
    const configErrors = [
      ...target.objects.configErrors.filter(error => !moveIds.has(Number(error.employee_id))),
      ...source.objects.configErrors.filter(error => moveIds.has(Number(error.employee_id))),
    ];
    objects = {
      payload: objectsPayload,
      hash: computeObjectsContentHash(objectsPayload, configErrors),
      configErrors,
      employeesCount: objectEmployees.length,
      totalHours: round2(objectEmployees.reduce((sum, employee) => sum + employee.total_hours, 0)),
    };
  }

  return {
    movedIds: [...moveIds].sort((a, b) => a - b),
    payload,
    contentHash: computeContentHash(payload),
    objects,
  };
}

const readRows = async <T extends object>(client: PoolClient | undefined, sql: string, params: unknown[]): Promise<T[]> => {
  if (client) return (await client.query(sql, params)).rows as T[];
  return query(sql, params) as Promise<T[]>;
};

const loadLatestVersion = async (client: PoolClient | undefined, approvalId: number): Promise<ILatestVersionRow> => {
  const [latest] = await readRows<ILatestVersionRow>(
    client,
    `SELECT v.id, v.revision, v.payload, v.scope_kind, v.membership_windows,
            vo.payload       AS objects_payload,
            vo.config_errors,
            vm.payload       AS managers_payload,
            (SELECT count(*) FROM timesheet_1c_exports x
               JOIN timesheet_versions av ON av.id = x.version_id
              WHERE av.approval_id = v.approval_id) AS acks
       FROM timesheet_versions v
       LEFT JOIN timesheet_version_objects vo  ON vo.version_id = v.id
       LEFT JOIN timesheet_version_managers vm ON vm.version_id = v.id
      WHERE v.approval_id = $1
      ORDER BY v.revision DESC
      LIMIT 1`,
    [approvalId],
  );
  if (!latest) throw new EmployeeMoveRefusedError(`у подачи ${approvalId} нет редакции`);
  return latest;
};

/** Сколько строк основы (сотрудник, месяц) у редакции — по списку людей или, наоборот, без него. */
const countBasisRows = async (
  client: PoolClient | undefined,
  versionId: number,
  employeeIds: readonly number[],
  include: boolean,
): Promise<number> => {
  const [row] = await readRows<{ total: string | number }>(
    client,
    `SELECT count(*) AS total
       FROM (SELECT DISTINCT employee_id, month FROM timesheet_version_payroll_basis
              WHERE version_id = $1 AND (employee_id = ANY($2::int[])) = $3) b`,
    [versionId, [...employeeIds], include],
  );
  return Number(row?.total ?? 0);
};

const assertAssignmentsFixed = async (
  client: PoolClient | undefined,
  from: IApprovalRow,
  to: IApprovalRow,
  employeeIds: readonly number[],
): Promise<void> => {
  // Нужен точный ответ, поэтому unknown здесь тоже отказ: иначе следующая редакция вернула бы дни обратно.
  const dates = enumerateDatesInclusive(from.start_date, from.end_date);
  const toId = Number(to.id);
  const fromId = Number(from.id);
  const ownership = await resolveDayOwnership(
    [
      { approvalId: toId, departmentId: to.department_id, employeeIds, dates },
      { approvalId: fromId, departmentId: from.department_id, employeeIds, dates },
    ],
    client,
  );
  for (const employeeId of employeeIds) {
    for (const date of dates) {
      if (ownership.get(ownershipKey(toId, employeeId, date)) !== 'owned'
        || ownership.get(ownershipKey(fromId, employeeId, date)) !== 'not_owned') {
        throw new EmployeeMoveRefusedError(
          `назначения не исправлены: сотрудник ${employeeId}, ${date} не принадлежит подаче ${toId}`,
        );
      }
    }
  }
};

/** Всё для переноса и все отказы — общее для отчёта без записи и для самого переноса. */
const buildMove = async (client: PoolClient | undefined, request: IEmployeeMoveRequest): Promise<TBuiltMove> => {
  const employeeIds = [...new Set(request.employeeIds.map(Number))].sort((a, b) => a - b);
  if (employeeIds.length === 0) throw new EmployeeMoveRefusedError('не указаны сотрудники');

  const approvals = await readRows<IApprovalRow>(
    client,
    `SELECT id, department_id::text AS department_id, manager_employee_id,
            start_date::text AS start_date, end_date::text AS end_date, status,
            unlocked_at::text AS unlocked_at, version_dirty_at::text AS version_dirty_at
       FROM timesheet_approvals
      WHERE id = ANY($1::bigint[])`,
    [[request.fromApprovalId, request.toApprovalId]],
  );
  const from = approvals.find(row => Number(row.id) === request.fromApprovalId);
  const to = approvals.find(row => Number(row.id) === request.toApprovalId);
  if (!from || !to || request.fromApprovalId === request.toApprovalId) {
    throw new EmployeeMoveRefusedError(`нужны две разные подачи: ${request.fromApprovalId} и ${request.toApprovalId}`);
  }
  for (const approval of [from, to]) {
    if (!isRebuildableApproval(approval)) {
      throw new EmployeeMoveRefusedError(`подача ${approval.id} не закрыта или ждёт пересборки`);
    }
    if (!approval.department_id) throw new EmployeeMoveRefusedError(`подача ${approval.id} не отдела, а личная`);
  }
  if (from.start_date !== to.start_date || from.end_date !== to.end_date) {
    throw new EmployeeMoveRefusedError(`у подач ${from.id} и ${to.id} разные периоды`);
  }

  const fromLatest = await loadLatestVersion(client, request.fromApprovalId);
  const toLatest = await loadLatestVersion(client, request.toApprovalId);
  for (const [approvalId, latest] of [[request.fromApprovalId, fromLatest], [request.toApprovalId, toLatest]] as const) {
    if (Number(latest.acks) > 0) {
      throw new EmployeeMoveRefusedError(`1С уже подтверждала подачу ${approvalId}: нужен отдельный разбор`);
    }
  }

  await assertAssignmentsFixed(client, from, to, employeeIds);

  const inVersion = new Set(fromLatest.payload.employees.map(employee => Number(employee.identity.employee_id)));
  const roster = await readRows<{ employee_id: number | string }>(
    client,
    'SELECT employee_id FROM timesheet_approval_employees WHERE approval_id = $1 AND employee_id = ANY($2::bigint[])',
    [request.fromApprovalId, employeeIds],
  );
  const inRoster = new Set(roster.map(row => Number(row.employee_id)));
  const allInSource = employeeIds.every(id => inVersion.has(id) && inRoster.has(id));
  const noneInSource = employeeIds.every(id => !inVersion.has(id) && !inRoster.has(id));

  if (noneInSource) {
    // «Нет в источнике» — ещё не «перенесены»: часы обязаны быть в цели, иначе они потеряны.
    const targetRows = new Map(toLatest.payload.employees.map(employee => [Number(employee.identity.employee_id), employee]));
    for (const employeeId of employeeIds) {
      const row = targetRows.get(employeeId);
      if (!row || dayCount(row) === 0 || !(row.total_hours > 0)) {
        throw new EmployeeMoveRefusedError(
          `сотрудника ${employeeId} нет в подаче ${request.fromApprovalId}, но и в подаче ${request.toApprovalId} нет его дней`,
        );
      }
    }
    return { state: 'already_moved', from, to, fromLatest, toLatest, employeeIds };
  }
  if (!allInSource) {
    throw new EmployeeMoveRefusedError(
      `подача ${request.fromApprovalId}: часть сотрудников из ${employeeIds.join(', ')} уже перенесена или есть только в одном из снимков`,
    );
  }

  for (const employeeId of employeeIds) {
    if (await countBasisRows(client, Number(fromLatest.id), [employeeId], true) === 0) {
      throw new EmployeeMoveRefusedError(`в подаче ${request.fromApprovalId} нет основы зарплаты сотрудника ${employeeId}`);
    }
  }

  const moveSet = new Set(employeeIds);
  const merged = mergeEmployeesIntoVersion(toStored(toLatest), toStored(fromLatest), moveSet);
  const withoutMoved = removeEmployeesFromVersion(toStored(fromLatest), moveSet);
  return { state: 'move', from, to, fromLatest, toLatest, employeeIds, withoutMoved, merged };
};

const toPlan = (built: TBuiltMove): IEmployeeMovePlan => {
  const { from, to, fromLatest, toLatest } = built;
  const idSet = new Set(built.employeeIds);
  const rows = (built.state === 'move' ? fromLatest : toLatest).payload.employees
    .filter(employee => idSet.has(Number(employee.identity.employee_id)));
  const after = built.state === 'move'
    ? { from: built.withoutMoved.payload, to: built.merged.payload }
    : { from: fromLatest.payload, to: toLatest.payload };
  const side = (approval: IApprovalRow, latest: ILatestVersionRow, payloadAfter: ITimesheetVersionPayload): IEmployeeMoveSide => ({
    approvalId: Number(approval.id),
    departmentName: latest.payload.approval.scope.department_name,
    revision: latest.revision,
    versionId: Number(latest.id),
    employeesBefore: latest.payload.employees_count,
    employeesAfter: payloadAfter.employees_count,
    hoursBefore: latest.payload.total_hours,
    hoursAfter: payloadAfter.total_hours,
  });
  return {
    state: built.state,
    startDate: from.start_date,
    endDate: from.end_date,
    employees: rows.map(employee => ({
      employeeId: Number(employee.identity.employee_id),
      fullName: employee.identity.full_name,
      hours: employee.total_hours,
      days: dayCount(employee),
    })),
    from: side(from, fromLatest, after.from),
    to: side(to, toLatest, after.to),
  };
};

/** Отчёт без записи: что перенесётся и какие будут итоги. Те же отказы, что у переноса. */
export async function previewEmployeeMove(request: IEmployeeMoveRequest): Promise<IEmployeeMovePlan> {
  return toPlan(await buildMove(undefined, request));
}

const insertTargetRevision = async (client: PoolClient, built: IBuiltPendingMove): Promise<{ id: number; revision: number }> => {
  const { to, toLatest, merged } = built;
  const revision = Number(toLatest.revision) + 1;
  const { rows } = await client.query<{ id: number | string }>(
    `INSERT INTO timesheet_versions (
       approval_id, revision, content_hash, payload, scope_kind, department_id,
       manager_employee_id, start_date, end_date, employees_count, total_hours,
       membership_windows, source, created_by
     ) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,'rebuild',NULL)
     RETURNING id`,
    [
      to.id,
      revision,
      merged.contentHash,
      JSON.stringify(merged.payload),
      toLatest.scope_kind,
      to.department_id,
      to.manager_employee_id,
      to.start_date,
      to.end_date,
      merged.payload.employees_count,
      merged.payload.total_hours,
      JSON.stringify(toLatest.membership_windows ?? {}),
    ],
  );
  const id = Number(rows[0]!.id);
  if (merged.objects) await insertObjectsSnapshot(client, id, merged.objects, 'materialize');
  // Состав и руководители целевой подачи не меняются: снимок переносится как есть.
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
    [id, toLatest.id],
  );
  return { id, revision };
};

/** copyPayrollBasis при ошибке откатывается к savepoint и не бросает, поэтому сверяем сами. */
const assertBasisCopied = async (
  client: PoolClient,
  built: IBuiltPendingMove,
  newToVersionId: number,
  newFromVersionId: number,
): Promise<void> => {
  const { fromLatest, toLatest, employeeIds } = built;
  const checks: Array<[string, number, number]> = [
    ['перенесённые', await countBasisRows(client, Number(fromLatest.id), employeeIds, true), await countBasisRows(client, newToVersionId, employeeIds, true)],
    ['остальные цели', await countBasisRows(client, Number(toLatest.id), employeeIds, false), await countBasisRows(client, newToVersionId, employeeIds, false)],
    ['остальные источника', await countBasisRows(client, Number(fromLatest.id), employeeIds, false), await countBasisRows(client, newFromVersionId, employeeIds, false)],
  ];
  for (const [label, expected, actual] of checks) {
    if (expected !== actual) {
      throw new Error(`основа зарплаты не перенеслась (${label}): ожидалось ${expected} строк, записано ${actual}`);
    }
  }
};

const assertSameRows = (label: string, expected: ReadonlyMap<number, string>, actual: ReadonlyMap<number, string>): void => {
  if (expected.size !== actual.size) {
    throw new Error(`проверка результата (${label}): ожидалось ${expected.size} строк, получено ${actual.size}`);
  }
  for (const [employeeId, row] of expected) {
    if (actual.get(employeeId) !== row) throw new Error(`проверка результата (${label}): строка сотрудника ${employeeId} не совпала`);
  }
};

/**
 * Читает записанные редакции обратно и сверяет по строкам: перенесённый в цели равен себе в
 * источнике, остальные равны прежним. Совпадение суммы часов этого не доказывает.
 */
const assertMovedRows = async (
  client: PoolClient,
  built: IBuiltPendingMove,
  newToVersionId: number,
  newFromVersionId: number,
): Promise<void> => {
  const idSet = new Set(built.employeeIds);
  const read = async (versionId: number) => (await client.query<{ payload: ITimesheetVersionPayload; objects: IVersionObjectsPayload | null }>(
    `SELECT v.payload, o.payload AS objects
       FROM timesheet_versions v
       LEFT JOIN timesheet_version_objects o ON o.version_id = v.id
      WHERE v.id = $1`,
    [versionId],
  )).rows[0]!;
  const payloadRows = (payload: ITimesheetVersionPayload) => new Map(payload.employees.map(
    employee => [Number(employee.identity.employee_id), canonicalJson(employee)] as const,
  ));
  const objectRows = (payload: IVersionObjectsPayload | null) => new Map((payload?.employees ?? []).map(
    employee => [Number(employee.employee_id), canonicalJson(employee)] as const,
  ));
  const merge = (target: Map<number, string>, source: Map<number, string>) => new Map(
    [...target].map(([id, row]) => [id, idSet.has(id) ? source.get(id) ?? '' : row] as const),
  );
  const without = (rows: Map<number, string>) => new Map([...rows].filter(([id]) => !idSet.has(id)));

  const newTo = await read(newToVersionId);
  const newFrom = await read(newFromVersionId);
  const fromObjects = built.fromLatest.objects_payload;
  const toObjects = built.toLatest.objects_payload;
  assertSameRows('цель', merge(payloadRows(built.toLatest.payload), payloadRows(built.fromLatest.payload)), payloadRows(newTo.payload));
  assertSameRows('источник', without(payloadRows(built.fromLatest.payload)), payloadRows(newFrom.payload));
  assertSameRows('разбивка цели', merge(objectRows(toObjects), objectRows(fromObjects)), objectRows(newTo.objects));
  assertSameRows('разбивка источника', without(objectRows(fromObjects)), objectRows(newFrom.objects));
};

const applyMove = async (client: PoolClient, built: IBuiltPendingMove, runId: string): Promise<IEmployeeMovePairResult> => {
  const { from, to, fromLatest, toLatest, employeeIds } = built;

  const target = await insertTargetRevision(client, built);
  await copyPayrollBasis(client, Number(toLatest.id), target.id, employeeIds);
  await copyPayrollBasisOfEmployees(client, Number(fromLatest.id), target.id, employeeIds);

  const removed = await rebuildVersionWithoutEmployees(client, {
    id: Number(from.id),
    department_id: from.department_id,
    manager_employee_id: from.manager_employee_id != null ? Number(from.manager_employee_id) : null,
    start_date: from.start_date,
    end_date: from.end_date,
    status: from.status,
  }, new Set(employeeIds));
  if (!removed.created || removed.revision == null || removed.removedIds.length !== employeeIds.length) {
    throw new Error(`подача ${from.id}: не удалось создать редакцию без перенесённых сотрудников`);
  }
  const newFrom = await client.query<{ id: number | string }>(
    'SELECT id FROM timesheet_versions WHERE approval_id = $1 AND revision = $2',
    [from.id, removed.revision],
  );
  const newFromVersionId = Number(newFrom.rows[0]!.id);
  await assertBasisCopied(client, built, target.id, newFromVersionId);
  await assertMovedRows(client, built, target.id, newFromVersionId);

  // Иначе при следующем закрытии источника они вернулись бы в его состав пустыми строками.
  const deleted = await client.query(
    'DELETE FROM timesheet_approval_employees WHERE approval_id = $1 AND employee_id = ANY($2::bigint[])',
    [from.id, employeeIds],
  );
  if (deleted.rowCount !== employeeIds.length) {
    throw new Error(`подача ${from.id}: в снимке состава ${deleted.rowCount} из ${employeeIds.length} сотрудников`);
  }

  // Внутри транзакции, а не после неё: на этой записи держится откат, поэтому редакций без
  // следа быть не должно. При повторе транзакции запись откатывается вместе с ней, дублей нет.
  await auditService.logWithClient(client, {
    user_id: null,
    action: AUDIT_ACTIONS.TIMESHEET_VERSION_EMPLOYEES_MOVED,
    entity_type: 'timesheet_approval',
    entity_id: String(from.id),
    details: {
      run_id: runId,
      from_approval_id: Number(from.id),
      to_approval_id: Number(to.id),
      from_version_before: Number(fromLatest.id),
      from_version_after: newFromVersionId,
      from_revision: removed.revision,
      to_version_before: Number(toLatest.id),
      to_version_after: target.id,
      to_revision: target.revision,
      moved_employees: employeeIds,
    },
  });

  return {
    fromApprovalId: Number(from.id),
    toApprovalId: Number(to.id),
    fromRevision: removed.revision,
    toRevision: target.revision,
    movedIds: employeeIds,
  };
};

/** Перенос всех пар одной транзакцией: новые редакции, снимок состава источника и аудит. */
export async function moveEmployeesBetweenApprovals(requests: readonly IEmployeeMoveRequest[]): Promise<IEmployeeMoveResult> {
  const runId = randomUUID();
  const approvalIds = [...new Set(requests.flatMap(request => [request.fromApprovalId, request.toApprovalId]))].sort((a, b) => a - b);

  // Состав для локов — до транзакции: локи берутся раньше снимка REPEATABLE READ.
  const roster = await query<{ employee_id: number | string; start_date: string; end_date: string }>(
    `SELECT DISTINCT t.employee_id, a.start_date::text AS start_date, a.end_date::text AS end_date
       FROM timesheet_approval_employees t
       JOIN timesheet_approvals a ON a.id = t.approval_id
      WHERE t.approval_id = ANY($1::bigint[])`,
    [approvalIds],
  );
  const lockPairs = roster.flatMap(row => monthAnchorsInRange(row.start_date, row.end_date)
    .map(workDate => ({ employeeId: Number(row.employee_id), workDate })));

  const pairs = await withTimesheetSnapshotTransaction(lockPairs, async (client): Promise<IEmployeeMovePairResult[]> => {
    // По порядку id и сразу все: иначе две параллельные операции могли бы взять подачи встречно.
    await client.query('SELECT id FROM timesheet_approvals WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE', [approvalIds]);
    const applied: IEmployeeMovePairResult[] = [];
    for (const request of requests) {
      const built = await buildMove(client, request);
      if (built.state === 'move') applied.push(await applyMove(client, built, runId));
    }
    return applied;
  });

  return { runId, pairs };
}
