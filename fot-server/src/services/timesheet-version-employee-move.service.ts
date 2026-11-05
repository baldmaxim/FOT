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
 * Обе подачи — новая revision с source 'rebuild' в одной транзакции под локами утверждения.
 * Повтор ничего не делает: сотрудника в подаче-источнике уже нет.
 */
import type { PoolClient } from 'pg';
import { query } from '../config/postgres.js';
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

export interface IEmployeeMoveSide {
  approvalId: number;
  departmentName: string | null;
  revision: number;
  employeesBefore: number;
  employeesAfter: number;
  hoursBefore: number;
  hoursAfter: number;
  /** Подтверждений 1С по подаче: больше нуля — 1С должна перечитать её. */
  acks: number;
}

export interface IEmployeeMovePlan {
  startDate: string;
  endDate: string;
  moved: Array<{ employeeId: number; fullName: string | null; hours: number; days: number }>;
  from: IEmployeeMoveSide;
  to: IEmployeeMoveSide;
}

export interface IEmployeeMoveResult {
  created: boolean;
  fromRevision: number | null;
  toRevision: number | null;
  movedIds: number[];
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

interface IBuiltMove {
  from: IApprovalRow;
  to: IApprovalRow;
  fromLatest: ILatestVersionRow;
  toLatest: ILatestVersionRow;
  movedIds: number[];
  withoutMoved: IVersionWithoutEmployees;
  merged: IVersionWithMovedEmployees | null;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

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
    if (Object.keys(targetRow.days ?? {}).length > 0 || targetRow.total_hours !== 0) {
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

/** Всё для переноса и все отказы — общее для отчёта без записи и для самого переноса. */
const buildMove = async (
  client: PoolClient | undefined,
  request: IEmployeeMoveRequest,
  forUpdate: boolean,
): Promise<IBuiltMove> => {
  const approvals = await readRows<IApprovalRow>(
    client,
    `SELECT id, department_id::text AS department_id, manager_employee_id,
            start_date::text AS start_date, end_date::text AS end_date, status,
            unlocked_at::text AS unlocked_at, version_dirty_at::text AS version_dirty_at
       FROM timesheet_approvals
      WHERE id = ANY($1::bigint[])
      ORDER BY id${forUpdate ? ' FOR UPDATE' : ''}`,
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

  const [fromLatest, toLatest] = [
    await loadLatestVersion(client, request.fromApprovalId),
    await loadLatestVersion(client, request.toApprovalId),
  ];

  const inSource = new Set(fromLatest.payload.employees.map(employee => Number(employee.identity.employee_id)));
  const movedIds = [...new Set(request.employeeIds.map(Number))].filter(id => inSource.has(id)).sort((a, b) => a - b);
  const moveSet = new Set(movedIds);
  const withoutMoved = removeEmployeesFromVersion(toStored(fromLatest), moveSet);
  if (movedIds.length === 0) return { from, to, fromLatest, toLatest, movedIds, withoutMoved, merged: null };

  // Перенос имеет смысл, только когда назначения уже исправлены: иначе следующая редакция
  // вернула бы дни обратно. Нужен точный ответ, поэтому unknown здесь тоже отказ.
  const dates = enumerateDatesInclusive(from.start_date, from.end_date);
  const ownership = await resolveDayOwnership(
    [
      { approvalId: request.toApprovalId, departmentId: to.department_id, employeeIds: movedIds, dates },
      { approvalId: request.fromApprovalId, departmentId: from.department_id, employeeIds: movedIds, dates },
    ],
    client,
  );
  for (const employeeId of movedIds) {
    for (const date of dates) {
      if (ownership.get(ownershipKey(request.toApprovalId, employeeId, date)) !== 'owned'
        || ownership.get(ownershipKey(request.fromApprovalId, employeeId, date)) !== 'not_owned') {
        throw new EmployeeMoveRefusedError(
          `назначения не исправлены: сотрудник ${employeeId}, ${date} не принадлежит подаче ${request.toApprovalId}`,
        );
      }
    }
    if (await countBasisRows(client, Number(fromLatest.id), [employeeId], true) === 0) {
      throw new EmployeeMoveRefusedError(`в подаче ${request.fromApprovalId} нет основы зарплаты сотрудника ${employeeId}`);
    }
  }

  const merged = mergeEmployeesIntoVersion(toStored(toLatest), toStored(fromLatest), moveSet);
  return { from, to, fromLatest, toLatest, movedIds, withoutMoved, merged };
};

const toPlan = (built: IBuiltMove): IEmployeeMovePlan => {
  const { from, to, fromLatest, toLatest, withoutMoved, merged } = built;
  const moveSet = new Set(built.movedIds);
  return {
    startDate: from.start_date,
    endDate: from.end_date,
    moved: fromLatest.payload.employees
      .filter(employee => moveSet.has(Number(employee.identity.employee_id)))
      .map(employee => ({
        employeeId: Number(employee.identity.employee_id),
        fullName: employee.identity.full_name,
        hours: employee.total_hours,
        days: Object.keys(employee.days ?? {}).length,
      })),
    from: {
      approvalId: Number(from.id),
      departmentName: fromLatest.payload.approval.scope.department_name,
      revision: fromLatest.revision,
      employeesBefore: fromLatest.payload.employees_count,
      employeesAfter: withoutMoved.payload.employees_count,
      hoursBefore: fromLatest.payload.total_hours,
      hoursAfter: withoutMoved.payload.total_hours,
      acks: Number(fromLatest.acks),
    },
    to: {
      approvalId: Number(to.id),
      departmentName: toLatest.payload.approval.scope.department_name,
      revision: toLatest.revision,
      employeesBefore: toLatest.payload.employees_count,
      employeesAfter: merged?.payload.employees_count ?? toLatest.payload.employees_count,
      hoursBefore: toLatest.payload.total_hours,
      hoursAfter: merged?.payload.total_hours ?? toLatest.payload.total_hours,
      acks: Number(toLatest.acks),
    },
  };
};

/** Отчёт без записи: что перенесётся и какие будут итоги. Те же отказы, что у переноса. */
export async function previewEmployeeMove(request: IEmployeeMoveRequest): Promise<IEmployeeMovePlan> {
  return toPlan(await buildMove(undefined, request, false));
}

const insertTargetRevision = async (client: PoolClient, built: IBuiltMove, merged: IVersionWithMovedEmployees): Promise<{ id: number; revision: number }> => {
  const { to, toLatest } = built;
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
  built: IBuiltMove,
  newToVersionId: number,
  newFromVersionId: number,
): Promise<void> => {
  const { fromLatest, toLatest, movedIds } = built;
  const checks: Array<[string, number, number]> = [
    ['перенесённые', await countBasisRows(client, Number(fromLatest.id), movedIds, true), await countBasisRows(client, newToVersionId, movedIds, true)],
    ['остальные цели', await countBasisRows(client, Number(toLatest.id), movedIds, false), await countBasisRows(client, newToVersionId, movedIds, false)],
    ['остальные источника', await countBasisRows(client, Number(fromLatest.id), movedIds, false), await countBasisRows(client, newFromVersionId, movedIds, false)],
  ];
  for (const [label, expected, actual] of checks) {
    if (expected !== actual) {
      throw new Error(`основа зарплаты не перенеслась (${label}): ожидалось ${expected} строк, записано ${actual}`);
    }
  }
};

/** Перенос: новые редакции обеих подач и снимок состава источника — одной транзакцией. */
export async function moveEmployeesBetweenApprovals(request: IEmployeeMoveRequest): Promise<IEmployeeMoveResult> {
  const preview = await buildMove(undefined, request, false);
  if (preview.movedIds.length === 0) return { created: false, fromRevision: null, toRevision: null, movedIds: [] };

  // Состав для локов — до транзакции: локи берутся раньше снимка REPEATABLE READ.
  const roster = await query<{ employee_id: number | string }>(
    'SELECT DISTINCT employee_id FROM timesheet_approval_employees WHERE approval_id = ANY($1::bigint[])',
    [[request.fromApprovalId, request.toApprovalId]],
  );
  const anchors = monthAnchorsInRange(preview.from.start_date, preview.from.end_date);
  const lockPairs = roster.flatMap(row => anchors.map(workDate => ({ employeeId: Number(row.employee_id), workDate })));

  const result = await withTimesheetSnapshotTransaction(lockPairs, async (client): Promise<IEmployeeMoveResult> => {
    const built = await buildMove(client, request, true);
    const { from, fromLatest, toLatest, movedIds, merged } = built;
    if (!merged) return { created: false, fromRevision: null, toRevision: null, movedIds: [] };

    const target = await insertTargetRevision(client, built, merged);
    await copyPayrollBasis(client, Number(toLatest.id), target.id, movedIds);
    await copyPayrollBasisOfEmployees(client, Number(fromLatest.id), target.id, movedIds);

    const removed = await rebuildVersionWithoutEmployees(client, {
      id: Number(from.id),
      department_id: from.department_id,
      manager_employee_id: from.manager_employee_id != null ? Number(from.manager_employee_id) : null,
      start_date: from.start_date,
      end_date: from.end_date,
      status: from.status,
    }, new Set(movedIds));
    if (!removed.created || removed.revision == null || removed.removedIds.length !== movedIds.length) {
      throw new Error(`подача ${from.id}: не удалось создать редакцию без перенесённых сотрудников`);
    }
    const newFrom = await client.query<{ id: number | string }>(
      'SELECT id FROM timesheet_versions WHERE approval_id = $1 AND revision = $2',
      [from.id, removed.revision],
    );
    await assertBasisCopied(client, built, target.id, Number(newFrom.rows[0]!.id));

    // Иначе при следующем закрытии источника они вернулись бы в его состав пустыми строками.
    const deleted = await client.query(
      'DELETE FROM timesheet_approval_employees WHERE approval_id = $1 AND employee_id = ANY($2::bigint[])',
      [from.id, movedIds],
    );
    if (deleted.rowCount !== movedIds.length) {
      throw new Error(`подача ${from.id}: в снимке состава ${deleted.rowCount} из ${movedIds.length} сотрудников`);
    }

    return { created: true, fromRevision: removed.revision, toRevision: target.revision, movedIds };
  });

  if (result.created) {
    // Побочные эффекты — после транзакции: повтор снимка не должен их дублировать.
    await auditService.log({
      user_id: null,
      action: AUDIT_ACTIONS.TIMESHEET_VERSION_EMPLOYEES_MOVED,
      entity_type: 'timesheet_approval',
      entity_id: String(request.fromApprovalId),
      details: {
        to_approval_id: request.toApprovalId,
        from_revision: result.fromRevision,
        to_revision: result.toRevision,
        moved_employees: result.movedIds,
      },
    });
  }
  return result;
}
