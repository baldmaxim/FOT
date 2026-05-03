import { Response } from 'express';
import { z } from 'zod';
import { supabase } from '../config/database.js';
import { escapeLike } from '../utils/search.utils.js';
import type { AuthenticatedRequest, IResolvedSchedule, SalaryRaiseStatus } from '../types/index.js';
import { employeeChangesService } from '../services/employee-changes.service.js';
import { pushService } from '../services/push.service.js';
import { notificationService } from '../services/notification.service.js';
import { getIo } from '../socket/io-instance.js';
import { canAccessEmployeeInScope, resolveManagedDepartmentIds, resolveRequestDataScope } from '../services/data-scope.service.js';
import { listTravelObjects } from '../services/skud-travel.service.js';
import { buildAttendanceEntries, type IAttendanceEntry } from '../services/attendance.service.js';
import { getDisciplineViolations } from '../services/skud-discipline.service.js';
import {
  isEmployeeAssignedToDepartmentOnDate,
  listEmployeeIdsAssignedToDepartmentPeriod,
} from '../services/timesheet-department-assignments.service.js';
import {
  getScheduleForDate,
  loadCalendarMonth,
  resolveSchedulesForPeriod,
} from '../services/schedule.service.js';

const FLOW_VERSION = 2;
const REQUEST_TYPE_FALLBACK = 'other';
const DEFAULT_EFFECTIVE_DATE = () => new Date().toISOString().slice(0, 10);
const LEGACY_V2_KEY = '__salary_raise_v2';

const VALID_TRANSITIONS: Record<string, { action: string; next: SalaryRaiseStatus }[]> = {
  draft: [
    { action: 'submit', next: 'admin_review' },
    { action: 'cancel', next: 'cancelled' },
  ],
  admin_review: [
    { action: 'approve', next: 'approved' },
    { action: 'reject', next: 'rejected' },
  ],
};

const WORKED_STATUSES = new Set(['work', 'manual', 'remote']);
const TIMESHEET_STATUS_LABELS: Record<string, string> = {
  work: 'Работа',
  manual: 'Работа',
  remote: 'Удалёнка',
  sick: 'Больничный',
  vacation: 'Отпуск',
  dayoff: 'Выходной',
  absent: 'Неявка',
  unpaid: 'За свой счёт',
  educational_leave: 'Учебный отпуск',
};

const createOrUpdateRequestSchema = z.object({
  employee_id: z.coerce.number().int().positive(),
  current_salary_entered: z.coerce.number().positive(),
  requested_salary: z.coerce.number().positive(),
  work_object_id: z.string().trim().min(1),
  job_summary: z.string().trim().min(1),
  achievements: z.array(z.string()).min(3),
  manager_justification: z.string().trim().min(1),
}).transform((value) => ({
  ...value,
  achievements: value.achievements.map((item) => item.trim()).filter(Boolean),
})).superRefine((value, ctx) => {
  if (value.achievements.length < 3) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['achievements'],
      message: 'Нужно указать минимум 3 достижения',
    });
  }

  if (value.requested_salary <= value.current_salary_entered) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['requested_salary'],
      message: 'Желаемый оклад должен быть больше текущего',
    });
  }
});

const adminReviewSchema = z.object({
  action: z.enum(['approve', 'reject']),
  comment: z.string().trim().max(5000).optional().transform((value) => value || undefined),
});

type SalaryRaiseSchemaMode = 'v2' | 'legacy';

interface IMetricSummaryItem {
  key: string;
  label: string;
  count: number;
  highlight: string | null;
}

interface IMetricDetailItem {
  id: string;
  date: string;
  title: string;
  description: string;
}

let salaryRaiseSchemaModePromise: Promise<SalaryRaiseSchemaMode> | null = null;

const toRecord = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
);

const toStringOrNull = (value: unknown): string | null => (
  typeof value === 'string' && value.trim() ? value : null
);

const toNumberOrNull = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const mapStatusToClient = (status: unknown): SalaryRaiseStatus => {
  switch (status) {
    case 'admin_review':
    case 'draft':
    case 'approved':
    case 'rejected':
    case 'cancelled':
      return status;
    case 'supervisor_review':
    case 'hr_review':
    case 'finance_review':
      return 'admin_review';
    default:
      return 'draft';
  }
};

const normalizeAchievements = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => {
      if (typeof item === 'string') return item.trim();

      if (item && typeof item === 'object') {
        const record = item as Record<string, unknown>;
        const parts = [
          toStringOrNull(record.task),
          toStringOrNull(record.description),
          toStringOrNull(record.result),
          toStringOrNull(record.effect),
        ].filter((part): part is string => Boolean(part));

        return parts.join(' — ');
      }

      return '';
    })
    .filter(Boolean);
};

const normalizeAdminReview = (value: unknown): { action: 'approve' | 'reject'; comment: string | null } | null => {
  const record = toRecord(value);
  const action = toStringOrNull(record.action);

  if (action === 'approve' || action === 'reject') {
    return {
      action,
      comment: toStringOrNull(record.comment),
    };
  }

  return null;
};

const getLegacyV2Payload = (row: Record<string, unknown>): Record<string, unknown> => {
  const selfAssessment = toRecord(row.self_assessment);
  return toRecord(selfAssessment[LEGACY_V2_KEY]);
};

const buildLegacyV2Payload = (input: {
  current_salary_entered: number;
  work_object_id: string;
  work_object_name: string;
  job_summary: string;
  manager_justification: string;
  manager_snapshot: Record<string, unknown> | null;
}): Record<string, unknown> => ({
  flow_version: FLOW_VERSION,
  current_salary_entered: input.current_salary_entered,
  work_object_id: input.work_object_id,
  work_object_name: input.work_object_name,
  job_summary: input.job_summary,
  manager_justification: input.manager_justification,
  manager_snapshot: input.manager_snapshot,
});

const normalizeSalaryRaiseRequest = (row: Record<string, unknown>): Record<string, unknown> => {
  const legacyPayload = getLegacyV2Payload(row);
  const employeeSnapshot = toRecord(row.employee_snapshot);
  const managerSnapshot = toRecord(row.manager_snapshot);
  const normalizedManagerSnapshot = Object.keys(managerSnapshot).length > 0
    ? managerSnapshot
    : toRecord(legacyPayload.manager_snapshot);

  const requestedSalary = toNumberOrNull(row.requested_salary) ?? 0;
  const currentSalaryEntered = toNumberOrNull(row.current_salary_entered)
    ?? toNumberOrNull(legacyPayload.current_salary_entered)
    ?? toNumberOrNull(employeeSnapshot.current_salary);

  return {
    ...row,
    flow_version: toNumberOrNull(row.flow_version) ?? toNumberOrNull(legacyPayload.flow_version) ?? 1,
    status: mapStatusToClient(row.status),
    employee_snapshot: employeeSnapshot,
    manager_snapshot: Object.keys(normalizedManagerSnapshot).length > 0 ? normalizedManagerSnapshot : null,
    current_salary_entered: currentSalaryEntered,
    requested_salary: requestedSalary,
    raise_percentage: toNumberOrNull(row.raise_percentage) ?? 0,
    work_object_id: toStringOrNull(row.work_object_id) ?? toStringOrNull(legacyPayload.work_object_id),
    work_object_name: toStringOrNull(row.work_object_name)
      ?? toStringOrNull(legacyPayload.work_object_name)
      ?? toStringOrNull(employeeSnapshot.work_object),
    job_summary: toStringOrNull(row.job_summary) ?? toStringOrNull(legacyPayload.job_summary),
    achievements: normalizeAchievements(row.achievements),
    manager_justification: toStringOrNull(row.manager_justification)
      ?? toStringOrNull(legacyPayload.manager_justification)
      ?? toStringOrNull(row.reason_brief),
    admin_review: normalizeAdminReview(row.admin_review) ?? normalizeAdminReview(row.finance_review),
    admin_reviewer_id: toStringOrNull(row.admin_reviewer_id) ?? toStringOrNull(row.finance_reviewer_id),
    admin_reviewed_at: toStringOrNull(row.admin_reviewed_at) ?? toStringOrNull(row.finance_reviewed_at),
  };
};

const resolveSalaryRaiseSchemaMode = async (): Promise<SalaryRaiseSchemaMode> => {
  if (!salaryRaiseSchemaModePromise) {
    salaryRaiseSchemaModePromise = (async () => {
      const { error } = await supabase
        .from('salary_raise_requests')
        .select('flow_version')
        .limit(1);

      if (!error) return 'v2';

      if (typeof error.message === 'string' && error.message.includes('flow_version')) {
        return 'legacy';
      }

      throw error;
    })().catch((error) => {
      salaryRaiseSchemaModePromise = null;
      throw error;
    });
  }

  return salaryRaiseSchemaModePromise;
};

const getNextStatus = (current: string, action: string): SalaryRaiseStatus | null => {
  const transitions = VALID_TRANSITIONS[current];
  if (!transitions) return null;
  const transition = transitions.find((item) => item.action === action);
  return transition ? transition.next : null;
};

const toIsoDate = (value: Date): string => value.toISOString().slice(0, 10);

const addDays = (input: string, diff: number): string => {
  const date = new Date(`${input}T00:00:00`);
  date.setDate(date.getDate() + diff);
  return toIsoDate(date);
};

const getMonthRanges = (startDate: string, endDate: string): Array<{ monthKey: string; startDate: string; endDate: string }> => {
  const result: Array<{ monthKey: string; startDate: string; endDate: string }> = [];
  const cursor = new Date(`${startDate}T00:00:00`);
  const finish = new Date(`${endDate}T00:00:00`);

  while (cursor <= finish) {
    const year = cursor.getFullYear();
    const month = cursor.getMonth() + 1;
    const monthKey = `${year}-${String(month).padStart(2, '0')}`;
    const monthStart = `${monthKey}-01`;
    const monthEnd = toIsoDate(new Date(year, month, 0));

    result.push({
      monthKey,
      startDate: startDate > monthStart ? startDate : monthStart,
      endDate: endDate < monthEnd ? endDate : monthEnd,
    });

    cursor.setMonth(cursor.getMonth() + 1);
    cursor.setDate(1);
  }

  return result;
};

const roundMoney = (value: number): number => Math.round(value * 100) / 100;

const calculateRaisePercentage = (currentSalary: number, requestedSalary: number): number => (
  Math.round((((requestedSalary - currentSalary) / currentSalary) * 100) * 10) / 10
);

const formatHours = (value: number): string => {
  const sign = value < 0 ? '-' : '';
  const totalMinutes = Math.round(Math.abs(value) * 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  return `${sign}${hours} ч ${String(minutes).padStart(2, '0')} мин`;
};

const formatDisplayDate = (value: string): string => {
  const [year, month, day] = value.slice(0, 10).split('-');
  if (!year || !month || !day) return value;

  return `${Number(day)}.${month}.${year}`;
};

const buildDisciplineDescription = (item: {
  first_entry: string | null;
  last_exit: string | null;
  total_hours: number | null;
  deviation: string;
  type: 'late' | 'underwork' | 'early' | 'absence';
}): string => {
  const entry = item.first_entry ? item.first_entry.slice(0, 5) : '—';
  const exit = item.last_exit ? item.last_exit.slice(0, 5) : '—';
  const worked = typeof item.total_hours === 'number' ? formatHours(item.total_hours) : '—';

  switch (item.type) {
    case 'late':
      return `Приход ${entry}, опоздание ${item.deviation}`;
    case 'underwork':
      return `${entry} -> ${exit}, отработано ${worked}, недоработка ${item.deviation}`;
    case 'early':
      return `${entry} -> ${exit}, ранний уход ${item.deviation}`;
    case 'absence':
      return `${entry} -> ${exit}, отсутствие ${item.deviation}`;
  }
};

const notifyUsers = (userIds: string[], title: string, body: string) => {
  if (userIds.length === 0) return;

  pushService.sendSalaryRaiseNotification(userIds, title, body)
    .then((sentIds) => {
      const io = getIo();
      if (!io) return;

      for (const userId of sentIds) {
        io.to(`user:${userId}`).emit('salary_raise_notification', { title, body });
      }
    })
    .catch((error) => console.error('salary-raise notify error:', error));

  notificationService.createMany(
    userIds.map((userId) => ({ userId, type: 'salary_raise', title, body })),
  ).catch((error) => console.error('salary-raise notification save error:', error));
};

const loadDepartmentName = async (departmentId: string | null | undefined): Promise<string | null> => {
  if (!departmentId) return null;

  const { data } = await supabase
    .from('org_departments')
    .select('name')
    .eq('id', departmentId)
    .maybeSingle();

  return typeof data?.name === 'string' ? data.name : null;
};

const loadPositionName = async (positionId: string | null | undefined): Promise<string | null> => {
  if (!positionId) return null;

  const { data } = await supabase
    .from('positions')
    .select('name')
    .eq('id', positionId)
    .maybeSingle();

  return typeof data?.name === 'string' ? data.name : null;
};

const getScopedCandidateEmployeeIds = async (req: AuthenticatedRequest): Promise<number[]> => {
  const scope = await resolveRequestDataScope(req);
  if (!scope || scope === 'self') {
    return [];
  }

  if (scope === 'all') {
    const { data, error } = await supabase
      .from('employees')
      .select('id')
      .eq('employment_status', 'active')
      .eq('is_archived', false);

    if (error) throw error;

    return [...new Set((data || [])
      .map((row) => Number(row.id))
      .filter((value) => Number.isInteger(value) && value > 0)
      .filter((value) => value !== req.user.employee_id))];
  }

  const managedDepartmentIds = await resolveManagedDepartmentIds(req);
  if (managedDepartmentIds.length === 0) {
    return [];
  }

  const today = DEFAULT_EFFECTIVE_DATE();
  const employeeIdsByDepartment = await Promise.all(
    managedDepartmentIds.map(departmentId => listEmployeeIdsAssignedToDepartmentPeriod(departmentId, today, today)),
  );
  return [...new Set(employeeIdsByDepartment.flat())].filter((value) => value !== req.user.employee_id);
};

const canManageSalaryRaiseEmployee = async (req: AuthenticatedRequest, employeeId: number): Promise<boolean> => {
  if (req.user.employee_id != null && req.user.employee_id === employeeId) {
    return false;
  }

  const scope = await resolveRequestDataScope(req);
  if (!scope || scope === 'self') {
    return false;
  }

  if (scope === 'all') {
    return canAccessEmployeeInScope(req, employeeId);
  }

  const managedDepartmentIds = await resolveManagedDepartmentIds(req);
  if (managedDepartmentIds.length === 0) {
    return false;
  }

  const checks = await Promise.all(
    managedDepartmentIds.map(departmentId => isEmployeeAssignedToDepartmentOnDate(
      employeeId,
      departmentId,
      DEFAULT_EFFECTIVE_DATE(),
    )),
  );
  return checks.some(Boolean);
};

const buildEmployeeSnapshot = async (employeeId: number) => {
  const { data: employee, error } = await supabase
    .from('employees')
    .select('id, full_name, current_salary, hire_date, work_object, position_id, org_department_id, employment_status, is_archived')
    .eq('id', employeeId)
    .maybeSingle();

  if (error) throw error;
  if (!employee) return null;
  if (employee.is_archived || employee.employment_status !== 'active') return null;

  const [positionName, departmentName, profile, lastRaise] = await Promise.all([
    loadPositionName(employee.position_id),
    loadDepartmentName(employee.org_department_id),
    supabase.from('user_profiles').select('supervisor_id').eq('employee_id', employeeId).maybeSingle(),
    supabase
      .from('salary_history')
      .select('effective_date')
      .eq('employee_id', employeeId)
      .order('effective_date', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  let supervisorName: string | null = null;
  if (profile.data?.supervisor_id) {
    const { data: supervisorProfile } = await supabase
      .from('user_profiles')
      .select('full_name, employee_id')
      .eq('id', profile.data.supervisor_id)
      .maybeSingle();

    supervisorName = typeof supervisorProfile?.full_name === 'string' && supervisorProfile.full_name.trim()
      ? supervisorProfile.full_name
      : null;

    if (!supervisorName && supervisorProfile?.employee_id) {
      const { data: supervisorEmployee } = await supabase
        .from('employees')
        .select('full_name')
        .eq('id', supervisorProfile.employee_id)
        .maybeSingle();
      supervisorName = typeof supervisorEmployee?.full_name === 'string' ? supervisorEmployee.full_name : null;
    }
  }

  return {
    employee_id: employee.id,
    full_name: employee.full_name,
    position_name: positionName,
    department_name: departmentName,
    work_object: employee.work_object,
    current_salary: typeof employee.current_salary === 'number' ? employee.current_salary : null,
    hire_date: employee.hire_date,
    supervisor_name: supervisorName,
    last_raise_date: lastRaise.data?.effective_date || null,
  };
};

const buildManagerSnapshot = async (userId: string) => {
  const { data: profile, error } = await supabase
    .from('user_profiles')
    .select('id, full_name, employee_id, position_type')
    .eq('id', userId)
    .maybeSingle();

  if (error) throw error;
  if (!profile) return null;

  let fullName = typeof profile.full_name === 'string' ? profile.full_name : null;
  let departmentId: string | null = null;
  if ((!fullName || !fullName.trim()) && profile.employee_id) {
    const { data: employee } = await supabase
      .from('employees')
      .select('full_name, org_department_id')
      .eq('id', profile.employee_id)
      .maybeSingle();
    fullName = typeof employee?.full_name === 'string' ? employee.full_name : null;
    departmentId = typeof employee?.org_department_id === 'string' ? employee.org_department_id : null;
  } else if (profile.employee_id) {
    const { data: employee } = await supabase
      .from('employees')
      .select('org_department_id')
      .eq('id', profile.employee_id)
      .maybeSingle();
    departmentId = typeof employee?.org_department_id === 'string' ? employee.org_department_id : null;
  }

  const departmentName = await loadDepartmentName(departmentId);

  return {
    user_id: profile.id,
    employee_id: profile.employee_id,
    full_name: fullName,
    position_type: profile.position_type,
    department_name: departmentName,
  };
};

const getSalaryRaiseReviewerIds = async (excludeId?: string): Promise<string[]> => {
  const [{ data: roles, error: rolesError }, { data: pageAccess, error: pageAccessError }] = await Promise.all([
    supabase.from('system_roles').select('id, code, permissions, is_active'),
    supabase
      .from('role_page_access')
      .select('system_role_id, role_code')
      .eq('page_path', '/salary-raise-review')
      .eq('can_edit', true),
  ]);

  if (rolesError) throw rolesError;
  if (pageAccessError) throw pageAccessError;

  const roleIds = new Set<string>();
  const roleCodes = new Set<string>();

  for (const role of roles || []) {
    if (!role.is_active) continue;
    const permissions = Array.isArray(role.permissions) ? role.permissions : [];
    if (!permissions.includes('data.scope.all')) continue;

    const hasReviewAccess = (pageAccess || []).some((entry) => (
      (entry.system_role_id && entry.system_role_id === role.id)
      || (!entry.system_role_id && entry.role_code === role.code)
    ));

    if (!hasReviewAccess) continue;

    roleIds.add(role.id);
    roleCodes.add(role.code);
  }

  if (roleIds.size === 0 && roleCodes.size === 0) return [];

  let query = supabase
    .from('user_profiles')
    .select('id, system_role_id, position_type')
    .eq('is_approved', true);

  if (excludeId) {
    query = query.neq('id', excludeId);
  }

  const { data: users, error } = await query;
  if (error) throw error;

  return [...new Set((users || [])
    .filter((user) => {
      if (user.system_role_id && roleIds.has(user.system_role_id)) return true;
      return typeof user.position_type === 'string' && roleCodes.has(user.position_type);
    })
    .map((user) => user.id))];
};

const enrichWithNames = async (requests: Record<string, unknown>[]) => {
  const employeeIds = [...new Set(requests.map((request) => Number(request.employee_id)).filter(Number.isFinite))];
  if (employeeIds.length === 0) return requests;

  const { data: employees } = await supabase
    .from('employees')
    .select('id, full_name')
    .in('id', employeeIds);

  const nameMap = new Map((employees || []).map((employee) => [employee.id, employee.full_name]));

  return requests.map((request) => ({
    ...request,
    employee_name: nameMap.get(Number(request.employee_id)) || null,
  }));
};

const ensureSalaryRaiseRequestVisible = async (req: AuthenticatedRequest, requestId: number) => {
  const schemaMode = await resolveSalaryRaiseSchemaMode();

  let query = supabase
    .from('salary_raise_requests')
    .select('*')
    .eq('id', requestId);

  if (schemaMode === 'v2') {
    query = query.eq('flow_version', FLOW_VERSION);
  }

  const { data, error } = await query.maybeSingle();

  if (error) throw error;
  if (!data) return null;

  if (data.author_user_id === req.user.id) {
    return data;
  }

  if (await canAccessEmployeeInScope(req, Number(data.employee_id))) {
    return data;
  }

  return null;
};

const buildMonthlyAttendance = async (employeeId: number, startDate: string, endDate: string) => {
  const monthRanges = getMonthRanges(startDate, endDate);
  const employees = [{ id: employeeId }];
  const entries: IAttendanceEntry[] = [];
  const schedulesByDate = new Map<string, IResolvedSchedule>();

  for (const range of monthRanges) {
    const [year, month] = range.monthKey.split('-').map(Number);
    const [dailySchedulesMap, calendarMonth] = await Promise.all([
      resolveSchedulesForPeriod(employees, range.startDate, range.endDate),
      loadCalendarMonth(year, month),
    ]);

    const attendance = await buildAttendanceEntries({
      employees,
      startDate: range.startDate,
      endDate: range.endDate,
      dailySchedulesMap,
      calendarMonth,
      todayStr: endDate,
    });

    entries.push(...attendance.entries.filter((entry) => entry.employee_id === employeeId));

    const dailySchedules = dailySchedulesMap.get(employeeId);
    if (!dailySchedules) continue;

    for (const [date, schedule] of dailySchedules.entries()) {
      schedulesByDate.set(date, schedule);
    }
  }

  return { entries, schedulesByDate };
};

const buildTimesheetMetric = (
  key: string,
  label: string,
  entries: IAttendanceEntry[],
  mapper: (entry: IAttendanceEntry) => IMetricDetailItem,
): { summary: IMetricSummaryItem; details: IMetricDetailItem[] } => ({
  summary: {
    key,
    label,
    count: entries.length,
    highlight: null,
  },
  details: entries.map(mapper).sort((left, right) => right.date.localeCompare(left.date)),
});

const buildReviewContext = async (request: Record<string, unknown>) => {
  const employeeId = Number(request.employee_id);
  const createdAt = String(request.created_at).slice(0, 10);
  const startDate = addDays(createdAt, -89);
  const endDate = createdAt;

  const [discipline, attendance] = await Promise.all([
    getDisciplineViolations({
      startMonth: startDate.slice(0, 7),
      endMonth: endDate.slice(0, 7),
    }),
    buildMonthlyAttendance(employeeId, startDate, endDate),
  ]);

  const disciplineDetails = discipline.violations
    .filter((item) => item.employee_id === employeeId && item.date >= startDate && item.date <= endDate);

  const detailsByMetric: Record<string, IMetricDetailItem[]> = {};
  const summary: IMetricSummaryItem[] = [];

  for (const key of ['late', 'underwork', 'early', 'absence'] as const) {
    const labelMap: Record<typeof key, string> = {
      late: 'Опоздания',
      underwork: 'Недоработки',
      early: 'Ранние уходы',
      absence: 'Отсутствия >3ч',
    };

    const items = disciplineDetails
      .filter((item) => item.type === key)
      .map((item, index) => ({
        id: `${key}-${item.date}-${index}`,
        date: item.date,
        title: `${labelMap[key]} • ${formatDisplayDate(item.date)}`,
        description: buildDisciplineDescription(item),
      }))
      .sort((left, right) => right.date.localeCompare(left.date));

    detailsByMetric[key] = items;
    summary.push({
      key,
      label: labelMap[key],
      count: items.length,
      highlight: null,
    });
  }

  const overtimeEntries = attendance.entries
    .filter((entry) => entry.work_date >= startDate && entry.work_date <= endDate)
    .flatMap((entry) => {
      if (!WORKED_STATUSES.has(entry.status)) return [];
      if (typeof entry.hours_worked !== 'number') return [];

      const schedule = attendance.schedulesByDate.get(entry.work_date);
      if (!schedule) return [];

      const [year, month, day] = entry.work_date.split('-').map(Number);
      const plannedHours = getScheduleForDate(schedule, new Date(year, month - 1, day)).work_hours;
      const overtimeHours = roundMoney(entry.hours_worked - plannedHours);

      if (overtimeHours <= 0) return [];

      return [{
        id: `overtime-${entry.work_date}`,
        date: entry.work_date,
        title: `Переработка • ${formatDisplayDate(entry.work_date)}`,
        description: `Отработано ${formatHours(entry.hours_worked)} при норме ${formatHours(plannedHours)}. Переработка ${formatHours(overtimeHours)}.`,
        overtimeHours,
      }];
    })
    .sort((left, right) => right.date.localeCompare(left.date));

  detailsByMetric.overtime = overtimeEntries.map(({ id, date, title, description }) => ({
    id,
    date,
    title,
    description,
  }));
  summary.push({
    key: 'overtime',
    label: 'Переработки',
    count: overtimeEntries.length,
    highlight: overtimeEntries.length > 0
      ? formatHours(overtimeEntries.reduce((total, item) => total + item.overtimeHours, 0))
      : null,
  });

  const statusGroups: Array<{ key: string; label: string; status: string }> = [
    { key: 'vacation', label: 'Отпуска', status: 'vacation' },
    { key: 'sick', label: 'Больничные', status: 'sick' },
    { key: 'absent', label: 'Неявки', status: 'absent' },
    { key: 'remote', label: 'Удалёнка', status: 'remote' },
  ];

  for (const group of statusGroups) {
    const metricEntries = attendance.entries.filter((entry) => (
      entry.status === group.status
      && entry.work_date >= startDate
      && entry.work_date <= endDate
    ));

    const metric = buildTimesheetMetric(group.key, group.label, metricEntries, (entry) => ({
      id: `${group.key}-${entry.work_date}`,
      date: entry.work_date,
      title: `${TIMESHEET_STATUS_LABELS[entry.status] || group.label} • ${formatDisplayDate(entry.work_date)}`,
      description: typeof entry.hours_worked === 'number'
        ? `Статус табеля: ${TIMESHEET_STATUS_LABELS[entry.status] || entry.status}. Учтено ${formatHours(entry.hours_worked)}.`
        : `Статус табеля: ${TIMESHEET_STATUS_LABELS[entry.status] || entry.status}.`,
    }));

    detailsByMetric[group.key] = metric.details;
    summary.push(metric.summary);
  }

  return {
    period: {
      start_date: startDate,
      end_date: endDate,
    },
    summary,
    details_by_metric: detailsByMetric,
  };
};

const create = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const schemaMode = await resolveSalaryRaiseSchemaMode();
    const parsed = createOrUpdateRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: parsed.error.errors[0]?.message || 'Некорректные данные заявки' });
      return;
    }

    const payload = parsed.data;
    const isAllowedEmployee = await canManageSalaryRaiseEmployee(req, payload.employee_id);
    if (!isAllowedEmployee) {
      res.status(403).json({ success: false, error: 'Можно создавать заявку только на сотрудника в рамках доступного отдела' });
      return;
    }

    const [employeeSnapshot, managerSnapshot, objects] = await Promise.all([
      buildEmployeeSnapshot(payload.employee_id),
      buildManagerSnapshot(req.user.id),
      listTravelObjects(),
    ]);

    if (!employeeSnapshot) {
      res.status(404).json({ success: false, error: 'Сотрудник не найден или неактивен' });
      return;
    }

    const workObject = objects.find((item) => item.id === payload.work_object_id && item.is_active);
    if (!workObject) {
      res.status(400).json({ success: false, error: 'Выбранный объект не найден' });
      return;
    }

    const raisePercentage = calculateRaisePercentage(payload.current_salary_entered, payload.requested_salary);
    const legacyV2Payload = buildLegacyV2Payload({
      current_salary_entered: payload.current_salary_entered,
      work_object_id: workObject.id,
      work_object_name: workObject.name,
      job_summary: payload.job_summary,
      manager_justification: payload.manager_justification,
      manager_snapshot: managerSnapshot,
    });

    const insertPayload = schemaMode === 'v2'
      ? {
          employee_id: payload.employee_id,
          author_user_id: req.user.id,
          flow_version: FLOW_VERSION,
          status: 'draft',
          employee_snapshot: employeeSnapshot,
          manager_snapshot: managerSnapshot,
          current_salary_entered: payload.current_salary_entered,
          request_type: REQUEST_TYPE_FALLBACK,
          requested_salary: payload.requested_salary,
          raise_percentage: raisePercentage,
          desired_effective_date: DEFAULT_EFFECTIVE_DATE(),
          reason_brief: payload.manager_justification,
          achievements: payload.achievements,
          responsibility_changes: {},
          self_assessment: {},
          work_object_id: workObject.id,
          work_object_name: workObject.name,
          job_summary: payload.job_summary,
          manager_justification: payload.manager_justification,
          updated_at: new Date().toISOString(),
        }
      : {
          employee_id: payload.employee_id,
          author_user_id: req.user.id,
          status: 'draft',
          employee_snapshot: employeeSnapshot,
          request_type: REQUEST_TYPE_FALLBACK,
          requested_salary: payload.requested_salary,
          raise_percentage: raisePercentage,
          desired_effective_date: DEFAULT_EFFECTIVE_DATE(),
          reason_brief: payload.manager_justification,
          achievements: payload.achievements,
          responsibility_changes: {},
          self_assessment: {
            [LEGACY_V2_KEY]: legacyV2Payload,
          },
          updated_at: new Date().toISOString(),
        };

    const { data, error } = await supabase
      .from('salary_raise_requests')
      .insert(insertPayload)
      .select('*')
      .single();

    if (error) throw error;

    res.json({ success: true, data: normalizeSalaryRaiseRequest(data as Record<string, unknown>) });
  } catch (error) {
    console.error('salary-raise.create error:', error);
    res.status(500).json({ success: false, error: 'Ошибка создания заявки' });
  }
};

const update = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const schemaMode = await resolveSalaryRaiseSchemaMode();
    const requestId = Number(req.params.id);
    const existing = await ensureSalaryRaiseRequestVisible(req, requestId);

    if (!existing) {
      res.status(404).json({ success: false, error: 'Заявка не найдена' });
      return;
    }

    if (existing.author_user_id !== req.user.id) {
      res.status(403).json({ success: false, error: 'Можно редактировать только свою заявку' });
      return;
    }

    if (existing.status !== 'draft') {
      res.status(400).json({ success: false, error: 'Редактировать можно только черновик' });
      return;
    }

    const parsed = createOrUpdateRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: parsed.error.errors[0]?.message || 'Некорректные данные заявки' });
      return;
    }

    const payload = parsed.data;
    const isAllowedEmployee = await canManageSalaryRaiseEmployee(req, payload.employee_id);
    if (!isAllowedEmployee) {
      res.status(403).json({ success: false, error: 'Можно создавать заявку только на сотрудника в рамках доступного отдела' });
      return;
    }

    const [employeeSnapshot, managerSnapshot, objects] = await Promise.all([
      buildEmployeeSnapshot(payload.employee_id),
      buildManagerSnapshot(req.user.id),
      listTravelObjects(),
    ]);

    if (!employeeSnapshot) {
      res.status(404).json({ success: false, error: 'Сотрудник не найден или неактивен' });
      return;
    }

    const workObject = objects.find((item) => item.id === payload.work_object_id && item.is_active);
    if (!workObject) {
      res.status(400).json({ success: false, error: 'Выбранный объект не найден' });
      return;
    }

    const raisePercentage = calculateRaisePercentage(payload.current_salary_entered, payload.requested_salary);
    const legacyV2Payload = buildLegacyV2Payload({
      current_salary_entered: payload.current_salary_entered,
      work_object_id: workObject.id,
      work_object_name: workObject.name,
      job_summary: payload.job_summary,
      manager_justification: payload.manager_justification,
      manager_snapshot: managerSnapshot,
    });

    const updatePayload = schemaMode === 'v2'
      ? {
          employee_id: payload.employee_id,
          employee_snapshot: employeeSnapshot,
          manager_snapshot: managerSnapshot,
          current_salary_entered: payload.current_salary_entered,
          requested_salary: payload.requested_salary,
          raise_percentage: raisePercentage,
          reason_brief: payload.manager_justification,
          achievements: payload.achievements,
          work_object_id: workObject.id,
          work_object_name: workObject.name,
          job_summary: payload.job_summary,
          manager_justification: payload.manager_justification,
          updated_at: new Date().toISOString(),
        }
      : {
          employee_id: payload.employee_id,
          employee_snapshot: employeeSnapshot,
          requested_salary: payload.requested_salary,
          raise_percentage: raisePercentage,
          reason_brief: payload.manager_justification,
          achievements: payload.achievements,
          self_assessment: {
            ...toRecord(existing.self_assessment),
            [LEGACY_V2_KEY]: legacyV2Payload,
          },
          updated_at: new Date().toISOString(),
        };

    const { data, error } = await supabase
      .from('salary_raise_requests')
      .update(updatePayload)
      .eq('id', requestId)
      .select('*')
      .single();

    if (error) throw error;

    res.json({ success: true, data: normalizeSalaryRaiseRequest(data as Record<string, unknown>) });
  } catch (error) {
    console.error('salary-raise.update error:', error);
    res.status(500).json({ success: false, error: 'Ошибка обновления заявки' });
  }
};

const getMy = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const schemaMode = await resolveSalaryRaiseSchemaMode();
    let query = supabase
      .from('salary_raise_requests')
      .select('*')
      .eq('author_user_id', req.user.id)
      .order('created_at', { ascending: false });

    if (schemaMode === 'v2') {
      query = query.eq('flow_version', FLOW_VERSION);
    }

    const { data, error } = await query;

    if (error) throw error;

    res.json({
      success: true,
      data: (data || []).map((item) => normalizeSalaryRaiseRequest(item as Record<string, unknown>)),
    });
  } catch (error) {
    console.error('salary-raise.getMy error:', error);
    res.status(500).json({ success: false, error: 'Ошибка получения заявок' });
  }
};

const getPending = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const schemaMode = await resolveSalaryRaiseSchemaMode();
    let query = supabase
      .from('salary_raise_requests')
      .select('*')
      .order('created_at', { ascending: false });

    if (schemaMode === 'v2') {
      query = query
        .eq('flow_version', FLOW_VERSION)
        .eq('status', 'admin_review');
    } else {
      query = query.in('status', ['admin_review', 'supervisor_review', 'hr_review', 'finance_review']);
    }

    const { data, error } = await query;

    if (error) throw error;

    const scoped: Record<string, unknown>[] = [];
    for (const request of data || []) {
      if (await canAccessEmployeeInScope(req, Number(request.employee_id))) {
        scoped.push(request);
      }
    }

    const enriched = await enrichWithNames(scoped);
    res.json({
      success: true,
      data: enriched.map((item) => normalizeSalaryRaiseRequest(item)),
    });
  } catch (error) {
    console.error('salary-raise.getPending error:', error);
    res.status(500).json({ success: false, error: 'Ошибка получения заявок' });
  }
};

const getAll = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const schemaMode = await resolveSalaryRaiseSchemaMode();
    let query = supabase
      .from('salary_raise_requests')
      .select('*')
      .order('created_at', { ascending: false });

    if (schemaMode === 'v2') {
      query = query.eq('flow_version', FLOW_VERSION);
    }

    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    if (status) {
      if (schemaMode === 'legacy' && status === 'admin_review') {
        query = query.in('status', ['admin_review', 'supervisor_review', 'hr_review', 'finance_review']);
      } else {
        query = query.eq('status', status);
      }
    }

    const { data, error } = await query;
    if (error) throw error;

    const scoped: Record<string, unknown>[] = [];
    for (const request of data || []) {
      if (await canAccessEmployeeInScope(req, Number(request.employee_id))) {
        scoped.push(request);
      }
    }

    const enriched = await enrichWithNames(scoped);
    res.json({
      success: true,
      data: enriched.map((item) => normalizeSalaryRaiseRequest(item)),
    });
  } catch (error) {
    console.error('salary-raise.getAll error:', error);
    res.status(500).json({ success: false, error: 'Ошибка получения заявок' });
  }
};

const getById = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const requestId = Number(req.params.id);
    const request = await ensureSalaryRaiseRequestVisible(req, requestId);

    if (!request) {
      res.status(404).json({ success: false, error: 'Заявка не найдена' });
      return;
    }

    res.json({ success: true, data: { ...normalizeSalaryRaiseRequest(request as Record<string, unknown>), attachments: [] } });
  } catch (error) {
    console.error('salary-raise.getById error:', error);
    res.status(500).json({ success: false, error: 'Ошибка получения заявки' });
  }
};

const getCandidates = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const search = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const candidateIds = await getScopedCandidateEmployeeIds(req);

    if (candidateIds.length === 0) {
      res.json({ success: true, data: [] });
      return;
    }

    let query = supabase
      .from('employees')
      .select('id, full_name, position_id, org_department_id, employment_status, is_archived')
      .in('id', candidateIds)
      .eq('employment_status', 'active')
      .eq('is_archived', false)
      .order('full_name')
      .limit(20);

    if (search) {
      query = query.ilike('full_name', `%${escapeLike(search)}%`);
    }

    const { data, error } = await query;
    if (error) throw error;

    const positionIds = [...new Set((data || []).map((item) => item.position_id).filter(Boolean))];
    const departmentIds = [...new Set((data || []).map((item) => item.org_department_id).filter(Boolean))];

    const [positions, departments] = await Promise.all([
      positionIds.length > 0
        ? supabase.from('positions').select('id, name').in('id', positionIds)
        : Promise.resolve({ data: [], error: null }),
      departmentIds.length > 0
        ? supabase.from('org_departments').select('id, name').in('id', departmentIds)
        : Promise.resolve({ data: [], error: null }),
    ]);

    if (positions.error) throw positions.error;
    if (departments.error) throw departments.error;

    const positionMap = new Map((positions.data || []).map((item) => [item.id, item.name]));
    const departmentMap = new Map((departments.data || []).map((item) => [item.id, item.name]));

    res.json({
      success: true,
      data: (data || []).map((item) => ({
        employee_id: item.id,
        full_name: item.full_name,
        position_name: item.position_id ? positionMap.get(item.position_id) || null : null,
        department_name: item.org_department_id ? departmentMap.get(item.org_department_id) || null : null,
      })),
    });
  } catch (error) {
    console.error('salary-raise.getCandidates error:', error);
    res.status(500).json({ success: false, error: 'Ошибка загрузки сотрудников' });
  }
};

const getObjects = async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const objects = await listTravelObjects();
    res.json({
      success: true,
      data: objects
        .filter((item) => item.is_active)
        .map((item) => ({ id: item.id, name: item.name }))
        .sort((left, right) => left.name.localeCompare(right.name, 'ru')),
    });
  } catch (error) {
    console.error('salary-raise.getObjects error:', error);
    res.status(500).json({ success: false, error: 'Ошибка загрузки объектов' });
  }
};

const submit = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const requestId = Number(req.params.id);
    const request = await ensureSalaryRaiseRequestVisible(req, requestId);

    if (!request) {
      res.status(404).json({ success: false, error: 'Заявка не найдена' });
      return;
    }

    if (request.author_user_id !== req.user.id) {
      res.status(403).json({ success: false, error: 'Можно отправить только свою заявку' });
      return;
    }

    const normalizedRequest = normalizeSalaryRaiseRequest(request as Record<string, unknown>);
    const nextStatus = getNextStatus(String(normalizedRequest.status), 'submit');
    if (!nextStatus) {
      res.status(400).json({ success: false, error: 'Невозможно отправить заявку в текущем статусе' });
      return;
    }

    const validation = createOrUpdateRequestSchema.safeParse({
      employee_id: normalizedRequest.employee_id,
      current_salary_entered: normalizedRequest.current_salary_entered,
      requested_salary: normalizedRequest.requested_salary,
      work_object_id: normalizedRequest.work_object_id,
      job_summary: normalizedRequest.job_summary,
      achievements: normalizedRequest.achievements,
      manager_justification: normalizedRequest.manager_justification,
    });

    if (!validation.success) {
      res.status(400).json({ success: false, error: validation.error.errors[0]?.message || 'Заполните все обязательные поля' });
      return;
    }

    const { data, error } = await supabase
      .from('salary_raise_requests')
      .update({
        status: nextStatus,
        updated_at: new Date().toISOString(),
      })
      .eq('id', requestId)
      .select('*')
      .single();

    if (error) throw error;

    const reviewerIds = await getSalaryRaiseReviewerIds(req.user.id);
    const employeeSnapshot = (request.employee_snapshot || {}) as Record<string, unknown>;
    notifyUsers(
      reviewerIds,
      'Заявка на повышение оклада',
      `Новая заявка на повышение оклада: ${String(employeeSnapshot.full_name || 'Сотрудник')}`,
    );

    res.json({ success: true, data: normalizeSalaryRaiseRequest(data as Record<string, unknown>) });
  } catch (error) {
    console.error('salary-raise.submit error:', error);
    res.status(500).json({ success: false, error: 'Ошибка отправки заявки' });
  }
};

const cancel = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const requestId = Number(req.params.id);
    const request = await ensureSalaryRaiseRequestVisible(req, requestId);

    if (!request) {
      res.status(404).json({ success: false, error: 'Заявка не найдена' });
      return;
    }

    if (request.author_user_id !== req.user.id) {
      res.status(403).json({ success: false, error: 'Можно отменить только свою заявку' });
      return;
    }

    const normalizedRequest = normalizeSalaryRaiseRequest(request as Record<string, unknown>);
    const nextStatus = getNextStatus(String(normalizedRequest.status), 'cancel');
    if (!nextStatus) {
      res.status(400).json({ success: false, error: 'Отменить можно только черновик' });
      return;
    }

    const { data, error } = await supabase
      .from('salary_raise_requests')
      .update({
        status: nextStatus,
        updated_at: new Date().toISOString(),
      })
      .eq('id', requestId)
      .select('*')
      .single();

    if (error) throw error;

    res.json({ success: true, data: normalizeSalaryRaiseRequest(data as Record<string, unknown>) });
  } catch (error) {
    console.error('salary-raise.cancel error:', error);
    res.status(500).json({ success: false, error: 'Ошибка отмены заявки' });
  }
};

const adminReview = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const requestId = Number(req.params.id);
    const parsed = adminReviewSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: parsed.error.errors[0]?.message || 'Некорректные данные решения' });
      return;
    }

    const request = await ensureSalaryRaiseRequestVisible(req, requestId);
    if (!request) {
      res.status(404).json({ success: false, error: 'Заявка не найдена' });
      return;
    }

    const schemaMode = await resolveSalaryRaiseSchemaMode();
    const normalizedRequest = normalizeSalaryRaiseRequest(request as Record<string, unknown>);
    if (normalizedRequest.status !== 'admin_review') {
      res.status(400).json({ success: false, error: 'Заявка не находится на рассмотрении администратора' });
      return;
    }

    const nextStatus = getNextStatus(String(normalizedRequest.status), parsed.data.action);
    if (!nextStatus) {
      res.status(400).json({ success: false, error: 'Недопустимое действие' });
      return;
    }

    const reviewPayload = {
      action: parsed.data.action,
      comment: parsed.data.comment || null,
    };

    const { data, error } = await supabase
      .from('salary_raise_requests')
      .update(
        schemaMode === 'v2'
          ? {
              status: nextStatus,
              admin_review: reviewPayload,
              admin_reviewer_id: req.user.id,
              admin_reviewed_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            }
          : {
              status: nextStatus,
              finance_review: reviewPayload,
              finance_reviewer_id: req.user.id,
              finance_reviewed_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
      )
      .eq('id', requestId)
      .select('*')
      .single();

    if (error) throw error;

    if (parsed.data.action === 'approve') {
      await employeeChangesService.changeSalary(Number(request.employee_id), Number(request.requested_salary), {
        effectiveDate: DEFAULT_EFFECTIVE_DATE(),
        reason: `Заявка на повышение #${requestId}`,
        createdBy: req.user.id,
      });
    }

    notifyUsers(
      [String(request.author_user_id)],
      'Заявка на повышение оклада',
      parsed.data.action === 'approve'
        ? 'Ваша заявка на повышение оклада одобрена.'
        : 'Ваша заявка на повышение оклада отклонена.',
    );

    res.json({ success: true, data: normalizeSalaryRaiseRequest(data as Record<string, unknown>) });
  } catch (error) {
    console.error('salary-raise.adminReview error:', error);
    res.status(500).json({ success: false, error: 'Ошибка рассмотрения заявки' });
  }
};

const getReviewContext = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const requestId = Number(req.params.id);
    const request = await ensureSalaryRaiseRequestVisible(req, requestId);

    if (!request) {
      res.status(404).json({ success: false, error: 'Заявка не найдена' });
      return;
    }

    const data = await buildReviewContext(normalizeSalaryRaiseRequest(request as Record<string, unknown>));
    res.json({ success: true, data });
  } catch (error) {
    console.error('salary-raise.getReviewContext error:', error);
    res.status(500).json({ success: false, error: 'Ошибка загрузки статистики по заявке' });
  }
};

export const salaryRaiseController = {
  create,
  update,
  getMy,
  getPending,
  getAll,
  getById,
  getCandidates,
  getObjects,
  submit,
  cancel,
  adminReview,
  getReviewContext,
};
