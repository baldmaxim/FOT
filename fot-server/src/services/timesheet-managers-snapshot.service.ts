// Снимок «руководитель отдела» для официальной версии табеля.
//
// Отвечает на вопрос 1С «кто у сотрудника начальник отдела». Собирается в той же
// транзакции, что и версия, и замораживается вместе с ней: живой резолвинг для одной
// revision после правки оргструктуры вернул бы другой ответ, и документ в 1С стал бы
// невоспроизводимым.
//
// Руководителем считается ТОЛЬКО назначенный на этот отдел (активный ручной full-доступ).
// Прямые руководители (employee_direct_reports), родительские отделы и подбор по
// должности/ФИО не используются — они дали бы человеку начальника из чужого отдела.
//
// Модуль чистый: без обращений к БД, весь вход передаётся аргументами.

import crypto from 'node:crypto';
import { canonicalJson } from '../utils/canonical-json.js';
import { isTestPersonName } from '../utils/person-name.utils.js';

export type ManagerResolutionStatus =
  | 'resolved'
  | 'multiple'
  | 'not_configured'
  | 'department_unknown'
  | 'invalid_configuration';

export type ManagerResolutionBasis = 'approval_department' | 'employee_assignment_period';

export type ManagerIssue =
  | 'manager_metadata_missing'
  | 'manager_dismissed'
  | 'manager_archived'
  | 'manager_name_looks_test';

export type EmployeeIssue =
  | 'department_changed_during_period'
  | 'department_history_missing'
  | 'department_unknown';

export interface IManagerRef {
  employee_id: number;
  full_name: string | null;
  employment_status: string | null;
  is_archived: boolean | null;
  source: 'department_full_access';
  data_quality_issues?: ManagerIssue[];
}

export interface IEmployeeManagers {
  employee_id: number;
  full_name: string | null;
  department_id: string | null;
  department_name: string | null;
  resolution_basis: ManagerResolutionBasis;
  resolution_status: ManagerResolutionStatus;
  managers: IManagerRef[];
  data_quality_issues?: EmployeeIssue[];
}

export interface IVersionManagersPayload {
  employees: IEmployeeManagers[];
}

export interface IManagerMeta {
  full_name: string | null;
  employment_status: string | null;
  is_archived: boolean | null;
}

/** Отдел сотрудника в рамках подачи + признаки качества истории. */
export interface IEmployeeDepartmentResolution {
  department_id: string | null;
  basis: ManagerResolutionBasis;
  changedDuringPeriod?: boolean;
  usedSnapshotFallback?: boolean;
}

export interface IBuildManagersSnapshotInput {
  /** Состав — из payload версии, а не из живых таблиц. */
  employees: ReadonlyArray<{ employee_id: number; full_name: string | null }>;
  departmentByEmployee: ReadonlyMap<number, IEmployeeDepartmentResolution>;
  /** departmentId → employee_id руководителей ЭТОГО отдела. */
  managersByDepartment: ReadonlyMap<string, number[]>;
  departmentNameById: ReadonlyMap<string, string | null>;
  managerMetaById: ReadonlyMap<number, IManagerMeta>;
}

export interface IBuildManagersSnapshotResult {
  payload: IVersionManagersPayload;
  employeesCount: number;
  withoutManager: number;
  withDataQualityIssues: number;
}

/**
 * Проблемы конкретного руководителя.
 *
 * Пустой список = запись пригодна к автоматическому использованию в 1С.
 */
function collectManagerIssues(meta: IManagerMeta | undefined): ManagerIssue[] {
  const issues: ManagerIssue[] = [];
  if (!meta) {
    issues.push('manager_metadata_missing');
    return issues;
  }
  if (!meta.full_name || meta.full_name.trim().length === 0) issues.push('manager_metadata_missing');
  if (meta.employment_status !== null && meta.employment_status !== 'active') {
    issues.push('manager_dismissed');
  }
  if (meta.is_archived === true) issues.push('manager_archived');
  // Проверка по подстроке ненадёжна, поэтому именно помечаем, а не удаляем запись.
  if (meta.full_name && isTestPersonName(meta.full_name)) issues.push('manager_name_looks_test');
  return issues;
}

/**
 * Статус резолвинга.
 *
 * «Руководителя нет» и «отдел неизвестен» разведены намеренно: первое — штатная
 * ситуация (на момент внедрения у ЛИНИЯ и ЛИНИЯ-Общестрой руководитель не назначен),
 * второе — проблема данных, о которой нужно сообщать.
 */
function resolveStatus(
  departmentId: string | null,
  managers: IManagerRef[],
): ManagerResolutionStatus {
  if (!departmentId) return 'department_unknown';
  if (managers.length === 0) return 'not_configured';
  const usable = managers.filter(m => (m.data_quality_issues?.length ?? 0) === 0);
  if (usable.length === 0) return 'invalid_configuration';
  return managers.length === 1 ? 'resolved' : 'multiple';
}

export function buildVersionManagersSnapshot(
  input: IBuildManagersSnapshotInput,
): IBuildManagersSnapshotResult {
  const employees: IEmployeeManagers[] = [];
  let withoutManager = 0;
  let withDataQualityIssues = 0;

  for (const source of input.employees) {
    const resolution = input.departmentByEmployee.get(source.employee_id);
    const departmentId = resolution?.department_id ?? null;

    const managerIds = departmentId ? (input.managersByDepartment.get(departmentId) ?? []) : [];
    const managers: IManagerRef[] = [...managerIds]
      .sort((a, b) => a - b)
      .map(managerId => {
        const meta = input.managerMetaById.get(managerId);
        const issues = collectManagerIssues(meta);
        const ref: IManagerRef = {
          employee_id: managerId,
          full_name: meta?.full_name ?? null,
          employment_status: meta?.employment_status ?? null,
          is_archived: meta?.is_archived ?? null,
          source: 'department_full_access',
        };
        // Запись НИКОГДА не выбрасывается: пропавший employee_id неотличим от
        // «руководителя нет», и 1С молча импортировала бы пустоту.
        if (issues.length > 0) ref.data_quality_issues = issues;
        return ref;
      });

    const employeeIssues: EmployeeIssue[] = [];
    if (!departmentId) {
      employeeIssues.push('department_unknown');
    } else {
      // Настоящий перевод внутри периода — история достоверна, а не неоднозначна:
      // сотрудник последовательно был в двух отделах, взят отдел на конец периода.
      if (resolution?.changedDuringPeriod) employeeIssues.push('department_changed_during_period');
      if (resolution?.usedSnapshotFallback) employeeIssues.push('department_history_missing');
    }

    const entry: IEmployeeManagers = {
      employee_id: source.employee_id,
      full_name: source.full_name,
      department_id: departmentId,
      department_name: departmentId
        ? (input.departmentNameById.get(departmentId) ?? null)
        : null,
      resolution_basis: resolution?.basis ?? 'employee_assignment_period',
      resolution_status: resolveStatus(departmentId, managers),
      managers,
    };
    if (employeeIssues.length > 0) entry.data_quality_issues = employeeIssues;

    if (managers.length === 0) withoutManager += 1;
    if (employeeIssues.length > 0 || managers.some(m => m.data_quality_issues)) {
      withDataQualityIssues += 1;
    }

    employees.push(entry);
  }

  employees.sort((left, right) => left.employee_id - right.employee_id);

  return {
    payload: { employees },
    employeesCount: employees.length,
    withoutManager,
    withDataQualityIssues,
  };
}

/**
 * md5 канонического payload.
 *
 * Участвует в решении о новой редакции наравне с content_hash и objects_content_hash:
 * смена руководителя при неизменных часах обязана быть замечена 1С, иначе документ
 * останется со старым начальником навсегда.
 */
export function computeManagersContentHash(payload: IVersionManagersPayload): string {
  return crypto.createHash('md5').update(canonicalJson(payload)).digest('hex');
}
