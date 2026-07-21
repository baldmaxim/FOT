import type { Response } from 'express';
import { query, queryOne, withTransaction } from '../config/postgres.js';
import type { AuthenticatedRequest } from '../types/index.js';
import { pushService } from '../services/push.service.js';
import { notificationService } from '../services/notification.service.js';
import { getIo } from '../socket/io-instance.js';
import { emitDomainChange } from '../services/realtime-broadcast.service.js';
import { getLeaveRequestRecipients, getEmployeeUserId } from '../services/recipients.service.js';
import { moscowTodayIso } from '../utils/date.utils.js';
import {
  canAccessEmployeeInScope,
  canEditEmployeeInScope,
  resolveAccessibleDepartmentIds,
  resolveManagedDepartmentIds,
  resolveScopedDepartmentId,
} from '../services/data-scope.service.js';
import { listDirectSubordinates } from '../services/employee-direct-reports.service.js';
import { resolveResponsibleEmployeeIdsByEmployee } from '../services/approval-routing.service.js';
import { resolveResponsibleEmployeeForTarget } from '../services/weekend-approval-assignments.service.js';
import { upsertAttendanceAdjustment, type DbExecutor } from '../services/attendance.service.js';
import { resolveAdjustmentApprovalStatus } from './timesheet.controller.js';
import { syncLeaveRequestReason } from '../services/leave-request-sync.service.js';
import { auditService } from '../services/audit.service.js';
import { listSelectableObjectsForEmployee } from '../services/employee-skud-object-access.service.js';
import { OBJECT_ADJUSTMENT_SOURCE_TYPE } from '../services/timesheet-object.service.js';
import type { TimeStatus } from '../types/index.js';

const LEAVE_REQUEST_TYPES = ['vacation', 'sick_leave', 'remote', 'certificate', 'time_correction', 'unpaid', 'work', 'educational_leave', 'sick_worked'] as const;
// Типы заявлений с адресной маршрутизацией: назначенный ответственный
// (employee_direct_reports) → иначе начальник отдела. Админ (scope=all) видит всё.
const ROUTED_LEAVE_TYPES = new Set<string>(['vacation', 'sick_leave', 'unpaid', 'work', 'sick_worked']);
// Типы «отпусков» для вкладки «Отпуска» (отдел кадров): ежегодный, за свой счёт,
// учебный. Больничные и прочее сюда не входят.
const VACATION_REQUEST_TYPES: string[] = ['vacation', 'unpaid', 'educational_leave'];
// Лимит причины отмены — тот же, что у текста заявления; дублируется на фронте.
const CANCEL_REASON_MAX_LENGTH = 500;
const LEAVE_TYPE_LABELS: Record<string, string> = {
  vacation: 'Отпуск', sick_leave: 'Больничный', remote: 'Удалёнка',
  certificate: 'Справка', time_correction: 'Корректировка', unpaid: 'За свой счёт',
  work: 'Работа в выходной/праздник', educational_leave: 'Учебный отпуск',
  sick_worked: 'Работа на больничном',
};
const LEAVE_TO_TIMESHEET: Record<'vacation' | 'sick_leave' | 'remote' | 'unpaid' | 'work' | 'educational_leave' | 'sick_worked', TimeStatus> = {
  vacation: 'vacation',
  sick_leave: 'sick',
  remote: 'remote',
  unpaid: 'unpaid',
  work: 'work',
  educational_leave: 'educational_leave',
  sick_worked: 'sick_worked',
};

function isTimeStatus(value: unknown): value is TimeStatus {
  return ['work', 'manual', 'vacation', 'remote', 'unpaid', 'absent', 'sick', 'educational_leave', 'sick_worked'].includes(String(value));
}

/** Компактная подпись дат для текста уведомлений: `01.05, 02.05, 11.05.2026` или `01.05.2026 — 16.05.2026`. */
function formatLeaveDateLabel(input: {
  request_type: string;
  start_date: string;
  end_date: string;
  correction_date: string | null;
  selected_dates: string[] | null;
}): string {
  const fmt = (iso: string): string => {
    const [y, m, d] = iso.split('-');
    return `${d}.${m}.${y}`;
  };
  const fmtShort = (iso: string): string => {
    const [, m, d] = iso.split('-');
    return `${d}.${m}`;
  };
  if (input.request_type === 'time_correction' && input.correction_date) {
    return fmt(input.correction_date);
  }
  if (input.selected_dates && input.selected_dates.length > 0) {
    const dates = input.selected_dates;
    if (dates.length === 1) return fmt(dates[0]);
    const year = dates[dates.length - 1].slice(0, 4);
    if (dates.length <= 4) return `${dates.slice(0, -1).map(fmtShort).join(', ')}, ${fmt(dates[dates.length - 1])}`;
    return `${dates.slice(0, 3).map(fmtShort).join(', ')} и ещё ${dates.length - 3} ${year}`;
  }
  return `${fmt(input.start_date)} — ${fmt(input.end_date)}`;
}

async function loadEmployeeIdsByDepartment(departmentId: string): Promise<Array<{ id: number; full_name: string | null }>> {
  return query<{ id: number; full_name: string | null }>(
    `SELECT id, full_name
       FROM employees
      WHERE org_department_id = $1
        AND employment_status = 'active'`,
    [departmentId],
  );
}

async function loadEmployeeIdsByDepartments(
  departmentIds: string[],
): Promise<Array<{ id: number; full_name: string | null; org_department_id?: string | null }>> {
  if (departmentIds.length === 0) {
    return [];
  }

  return query<{ id: number; full_name: string | null; org_department_id: string | null }>(
    `SELECT id, full_name, org_department_id
       FROM employees
      WHERE org_department_id = ANY($1::uuid[])
        AND employment_status = 'active'`,
    [departmentIds],
  );
}

interface IEmployeeMeta {
  id: number;
  full_name: string | null;
  org_department_id: string | null;
  department_name: string | null;
  position_name: string | null;
}

interface IAttachmentRow {
  leave_request_id: string;
  id: number;
  file_name: string;
  mime_type: string | null;
  file_size: number | null;
}

async function loadEmployeeMeta(employeeIds: number[]): Promise<Map<number, IEmployeeMeta>> {
  if (employeeIds.length === 0) return new Map();
  const rows = await query<IEmployeeMeta>(
    `SELECT e.id,
            e.full_name,
            e.org_department_id,
            od.name AS department_name,
            p.name  AS position_name
       FROM employees e
       LEFT JOIN org_departments od ON od.id = e.org_department_id
       LEFT JOIN positions p        ON p.id = e.position_id
      WHERE e.id = ANY($1::bigint[])`,
    [employeeIds],
  );
  return new Map(rows.map(r => [r.id, r]));
}

/** ФИО рецензентов (user_profiles) по reviewer_id для list-эндпоинтов. */
async function loadReviewerProfiles(
  reviewerIds: string[],
): Promise<Map<string, { id: string; full_name: string | null }>> {
  if (reviewerIds.length === 0) return new Map();
  const rows = await query<{ id: string; full_name: string | null }>(
    `SELECT id, full_name FROM user_profiles WHERE id = ANY($1::uuid[])`,
    [reviewerIds],
  );
  return new Map(rows.map(r => [r.id, r]));
}

type DecisionProfile = { id: string; full_name: string | null };
// Любая строка leave_requests: интересуют только reviewer_id / cancelled_by,
// но у вызывающих типы разные (SELECT * с разным набором явных полей).
type DecisionRow = Record<string, unknown>;

const asUuid = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** ФИО участников решения (согласовавший + отменивший) одним запросом. */
async function loadDecisionProfiles(rows: DecisionRow[]): Promise<Map<string, DecisionProfile>> {
  const ids = [...new Set(
    rows.flatMap(r => [asUuid(r.reviewer_id), asUuid(r.cancelled_by)]).filter((v): v is string => !!v),
  )];
  return loadReviewerProfiles(ids);
}

/** Подмешивает reviewer/canceller в строку заявления для ответа API. */
function withDecisionProfiles<T extends DecisionRow>(
  row: T,
  profiles: Map<string, DecisionProfile>,
): T & { reviewer: DecisionProfile | null; canceller: DecisionProfile | null } {
  const reviewerId = asUuid(row.reviewer_id);
  const cancelledBy = asUuid(row.cancelled_by);
  return {
    ...row,
    reviewer: reviewerId ? (profiles.get(reviewerId) ?? null) : null,
    canceller: cancelledBy ? (profiles.get(cancelledBy) ?? null) : null,
  };
}

async function loadAttachmentsByLeaveRequestIds(
  requestIds: number[],
): Promise<Map<number, Array<{ id: number; file_name: string; mime_type: string | null; file_size: number | null }>>> {
  const result = new Map<number, Array<{ id: number; file_name: string; mime_type: string | null; file_size: number | null }>>();
  if (requestIds.length === 0) return result;
  const rows = await query<IAttachmentRow>(
    `SELECT dl.entity_id AS leave_request_id,
            d.id,
            d.file_name,
            d.mime_type,
            d.file_size
       FROM document_links dl
       JOIN documents d ON d.id = dl.document_id
      WHERE dl.entity_type = 'leave_request'
        AND dl.entity_id = ANY($1::text[])`,
    [requestIds.map(String)],
  );
  for (const row of rows) {
    const key = Number(row.leave_request_id);
    if (!Number.isFinite(key)) continue;
    const list = result.get(key) || [];
    list.push({
      id: row.id,
      file_name: row.file_name,
      mime_type: row.mime_type,
      file_size: row.file_size,
    });
    result.set(key, list);
  }
  return result;
}

/**
 * Для уже approved заявок time_correction поднимаем текущий approval_status
 * связанной attendance_adjustments — фронт показывает «Ожидает согласования»,
 * если корректировка в статусе 'pending' (выходной в whitelist-отделе).
 */
async function loadCorrectionApprovalStatusByRequestIds(
  requestIds: number[],
): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  if (requestIds.length === 0) return result;
  const sourceIds = requestIds.flatMap(id => [String(id), `${id}:time_correction`]);
  const rows = await query<{ source_id: string; approval_status: string }>(
    `SELECT source_id, approval_status
       FROM attendance_adjustments
      WHERE source_type = 'leave_request'
        AND source_id = ANY($1::text[])`,
    [sourceIds],
  );
  const priority = new Map<string, number>([
    ['pending', 4],
    ['rejected', 3],
    ['approved', 2],
    ['auto_approved', 1],
  ]);
  for (const row of rows) {
    const reqIdStr = String(row.source_id).split(':')[0];
    const reqId = Number(reqIdStr);
    if (!Number.isFinite(reqId)) continue;
    const prev = result.get(reqId);
    if (!prev || (priority.get(row.approval_status) ?? 0) > (priority.get(prev) ?? 0)) {
      result.set(reqId, row.approval_status);
    }
  }
  return result;
}

function shouldLoadCorrectionApprovalStatus(request: { request_type: string; status: string }): boolean {
  return request.request_type === 'work'
    || (request.request_type === 'time_correction' && request.status === 'approved');
}

async function loadWorkRequestIdsPendingInApprovals(requestIds: number[]): Promise<Set<number>> {
  const ids = requestIds.filter(id => Number.isFinite(id));
  if (ids.length === 0) return new Set();
  const rows = await query<{ source_id: string }>(
    `SELECT DISTINCT source_id
       FROM attendance_adjustments
      WHERE source_type = 'leave_request'
        AND source_id = ANY($1::text[])
        AND approval_status = 'pending'`,
    [ids.map(String)],
  );
  return new Set(rows.map(r => Number(r.source_id)).filter(Number.isFinite));
}

function isPendingWorkRoutedToApprovals(
  request: { id: number; request_type: string; status: string },
  pendingWorkRequestIds: Set<number>,
): boolean {
  return request.request_type === 'work'
    && request.status === 'pending'
    && pendingWorkRequestIds.has(Number(request.id));
}

// Максимум материализуемых дней на одну заявку. Страхует от runaway-цикла в
// collectMaterializedLeaveDates: заявка с годом 0026 давала span ~730 000 дней и
// подвешивала approve (по upsert на каждый день внутри одной транзакции).
export const MAX_MATERIALIZED_LEAVE_DAYS = 366;

const LEAVE_DATE_ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

// Разбирает 'YYYY-MM-DD' в UTC-полночь и подтверждает, что дата реально существует.
// Round-trip отсеивает regex-валидные, но несуществующие даты ('2026-02-31'
// нормализовалась бы в март). pg отдаёт DATE как строку (postgres.ts, OID 1082),
// поэтому и из БД, и из тела запроса сюда приходит 'YYYY-MM-DD'.
export function parseStrictUtcLeaveDate(input: string): Date | null {
  if (typeof input !== 'string') return null;
  const iso = input.slice(0, 10);
  if (!LEAVE_DATE_ISO_RE.test(iso)) return null;
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt;
}

// Единая валидация периода заявки для create и approve: реальная календарная дата,
// год в пределах [текущий−1, текущий+5], start ≤ end и итоговое число материализуемых
// дат ≤ MAX_MATERIALIZED_LEAVE_DAYS (для selected_dates считаем уникальный набор и
// проверяем, что каждая дата лежит внутри [start, end]). Возвращает 400-совместимую
// ошибку — вызывать ДО транзакции.
export function validateLeaveRequestPeriod(
  startDate: string,
  endDate: string,
  selectedDates?: string[] | null,
): { ok: true } | { ok: false; error: string } {
  const start = parseStrictUtcLeaveDate(startDate);
  const end = parseStrictUtcLeaveDate(endDate);
  if (!start || !end) {
    return { ok: false, error: 'Некорректная дата заявления (ожидается формат ГГГГ-ММ-ДД)' };
  }

  const currentYear = new Date().getUTCFullYear();
  const minYear = currentYear - 1;
  const maxYear = currentYear + 5;
  for (const dt of [start, end]) {
    const y = dt.getUTCFullYear();
    if (y < minYear || y > maxYear) {
      return { ok: false, error: `Год заявления вне допустимого диапазона (${minYear}–${maxYear}) — проверьте дату` };
    }
  }

  if (start.getTime() > end.getTime()) {
    return { ok: false, error: 'Дата окончания раньше даты начала' };
  }

  if (Array.isArray(selectedDates) && selectedDates.length > 0) {
    const uniq = Array.from(new Set(selectedDates.map(String))).sort();
    for (const raw of uniq) {
      const d = parseStrictUtcLeaveDate(raw);
      if (!d) return { ok: false, error: 'Список дат содержит некорректную дату' };
      if (d.getTime() < start.getTime() || d.getTime() > end.getTime()) {
        return { ok: false, error: 'Список дат содержит дату вне периода заявления' };
      }
    }
    if (uniq.length > MAX_MATERIALIZED_LEAVE_DAYS) {
      return { ok: false, error: `Слишком много дат в заявлении (максимум ${MAX_MATERIALIZED_LEAVE_DAYS})` };
    }
  } else {
    const spanDays = Math.round((end.getTime() - start.getTime()) / MS_PER_DAY) + 1;
    if (spanDays > MAX_MATERIALIZED_LEAVE_DAYS) {
      return { ok: false, error: `Слишком большой период заявления (максимум ${MAX_MATERIALIZED_LEAVE_DAYS} дней)` };
    }
  }

  return { ok: true };
}

function collectMaterializedLeaveDates(request: {
  request_type: string;
  start_date: string;
  end_date: string;
  selected_dates: string[] | null;
}): string[] {
  const isSingleDayRange = request.start_date === request.end_date;
  const skipWeekends = request.request_type === 'remote' && !isSingleDayRange;
  const hasDiscreteDates = Array.isArray(request.selected_dates) && request.selected_dates.length > 0;
  const isoDates: string[] = [];

  if (hasDiscreteDates) {
    for (const raw of request.selected_dates as string[]) {
      const iso = typeof raw === 'string' ? raw.slice(0, 10) : new Date(raw).toISOString().slice(0, 10);
      if (iso) isoDates.push(iso);
    }
  } else {
    // Перебор в UTC (getUTCDate/setUTCDate/getUTCDay), чтобы не зависеть от локальной
    // таймзоны/DST. Второй рубеж защиты после validateLeaveRequestPeriod: если сюда
    // всё же попал огромный диапазон (легаси-данные) — не разворачиваем 730к дней.
    const startDate = parseStrictUtcLeaveDate(request.start_date) ?? new Date(request.start_date);
    const endDate = parseStrictUtcLeaveDate(request.end_date) ?? new Date(request.end_date);
    for (let d = new Date(startDate); d <= endDate; d.setUTCDate(d.getUTCDate() + 1)) {
      if (isoDates.length > MAX_MATERIALIZED_LEAVE_DAYS) {
        throw new Error('Слишком большой период заявления для материализации');
      }
      const dayOfWeek = d.getUTCDay();
      if (skipWeekends && (dayOfWeek === 0 || dayOfWeek === 6)) continue;
      isoDates.push(d.toISOString().split('T')[0]);
    }
  }

  return [...new Set(isoDates)].sort();
}

async function materializeLeaveRequestAdjustments(
  request: {
    id: number;
    employee_id: number;
    request_type: string;
    start_date: string;
    end_date: string;
    selected_dates: string[] | null;
    reason: string | null;
  },
  authorUserId: string,
  client: DbExecutor,
  // user_profiles.id одобряющего, если он сам — ответственный за выходные
  // сотрудника: pending-дни схлопываются в approved без второго этапа.
  weekendCollapseApproverUserId: string | null = null,
): Promise<{ dates: string[]; hasPending: boolean }> {
  const timesheetStatus = Object.prototype.hasOwnProperty.call(LEAVE_TO_TIMESHEET, request.request_type)
    ? LEAVE_TO_TIMESHEET[request.request_type as keyof typeof LEAVE_TO_TIMESHEET]
    : undefined;
  if (!timesheetStatus) return { dates: [], hasPending: false };

  const isoDates = collectMaterializedLeaveDates(request);
  let hasPending = false;

  for (const iso of isoDates) {
    const resolvedStatus = await resolveAdjustmentApprovalStatus(
      request.employee_id,
      iso,
      timesheetStatus,
      null,
    );
    const collapsed = resolvedStatus === 'pending' && weekendCollapseApproverUserId != null;
    const approvalStatus = collapsed ? ('approved' as const) : resolvedStatus;
    if (approvalStatus === 'pending') hasPending = true;

    await upsertAttendanceAdjustment({
      employee_id: request.employee_id,
      work_date: iso,
      status: timesheetStatus,
      hours_override: null,
      source_type: 'leave_request',
      source_id: String(request.id),
      reason: request.reason ?? null,
      created_by: authorUserId,
      approval_status: approvalStatus,
      approved_by: collapsed ? weekendCollapseApproverUserId : undefined,
    }, client);
  }

  return { dates: isoDates, hasPending };
}

function broadcastPendingChanged(): void {
  const io = getIo();
  if (io) io.emit('leave_request_pending_changed');
}

/** Создание заявления (worker+) */
const create = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { request_type, start_date, end_date, reason, correction_date, correction_status, correction_hours, attachments, selected_dates, correction_object_id } = req.body;
    if (!request_type || !start_date || !end_date) {
      res.status(400).json({ success: false, error: 'request_type, start_date, end_date обязательны' });
      return;
    }
    if (!LEAVE_REQUEST_TYPES.includes(request_type)) {
      res.status(400).json({ success: false, error: 'Недопустимый тип заявления' });
      return;
    }

    // Единая валидация периода для ВСЕХ типов (не только диапазонных): дискретный тип
    // без selected_dates тоже уходит в диапазонный цикл материализации. Отсекает битый
    // год (0026), несуществующую дату, start>end и слишком большой период на входе.
    const periodCheck = validateLeaveRequestPeriod(start_date, end_date, selected_dates);
    if (!periodCheck.ok) {
      res.status(400).json({ success: false, error: periodCheck.error });
      return;
    }

    // Валидация для time_correction
    if (request_type === 'time_correction') {
      if (!correction_date || !correction_status) {
        res.status(400).json({ success: false, error: 'correction_date и correction_status обязательны для корректировки' });
        return;
      }
    }

    // Дискретный набор дней (типы с выбором дат на календаре: work/remote/certificate/unpaid/sick_worked).
    // «За свой счёт» (unpaid) теперь подаётся датами, а не непрерывным периодом.
    // «Работа на больничном» (sick_worked) — конкретные дни, когда человек работал.
    // Для непрерывных периодов (vacation/sick_leave/educational_leave) и time_correction игнорируется.
    const DISCRETE_TYPES = new Set(['work', 'remote', 'certificate', 'unpaid', 'sick_worked']);
    let normalizedSelectedDates: string[] | null = null;
    if (DISCRETE_TYPES.has(request_type) && Array.isArray(selected_dates) && selected_dates.length > 0) {
      const dateRe = /^\d{4}-\d{2}-\d{2}$/;
      const uniq = Array.from(new Set(selected_dates.map(String))).sort();
      for (const d of uniq) {
        if (!dateRe.test(d) || d < start_date || d > end_date) {
          res.status(400).json({ success: false, error: 'selected_dates содержит некорректную или внепериодную дату' });
          return;
        }
      }
      normalizedSelectedDates = uniq;
    }

    const attachmentIds = Array.isArray(attachments)
      ? attachments.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)
      : [];

    const employeeId = req.user.employee_id;
    if (!employeeId) {
      res.status(400).json({ success: false, error: 'У пользователя нет привязки к сотруднику' });
      return;
    }

    // Корректировка табеля из ЛК обязательно привязывается к конкретному объекту
    // (skud_objects) — иначе при одобрении часы повиснут на «Не определён».
    // Проверяем, что объект доступен сотруднику.
    let correctionObjectName: string | null = null;
    if (request_type === 'time_correction') {
      if (!correction_object_id || typeof correction_object_id !== 'string') {
        res.status(400).json({ success: false, error: 'Выберите объект для корректировки' });
        return;
      }
      const selectable = await listSelectableObjectsForEmployee(employeeId);
      const match = selectable.find((o) => o.object_id === correction_object_id);
      if (!match) {
        res.status(400).json({ success: false, error: 'Объект недоступен для этого сотрудника' });
        return;
      }
      correctionObjectName = match.object_name;
    }

    if (attachmentIds.length > 0) {
      const docs = await query<{ id: number; employee_id: number | null }>(
        `SELECT id, employee_id FROM documents WHERE id = ANY($1::bigint[])`,
        [attachmentIds],
      );
      const owned = docs.filter(d => Number(d.employee_id) === Number(employeeId));
      if (owned.length !== attachmentIds.length) {
        res.status(400).json({ success: false, error: 'Файл-вложение не принадлежит этому сотруднику' });
        return;
      }
    }

    // Многошаговая операция: insert заявления + связь с документами в одной TX.
    // Корректировки (attendance_adjustments) НЕ создаются здесь: work-заявка сначала
    // проходит согласование в «Заявлениях», материализация — в approve().
    const data = await withTransaction(async (client) => {
      const insertCols: string[] = ['employee_id', 'request_type', 'start_date', 'end_date', 'reason'];
      const insertVals: unknown[] = [employeeId, request_type, start_date, end_date, reason || null];
      const insertCasts: string[] = ['', '', '', '', ''];
      if (request_type === 'time_correction') {
        insertCols.push('correction_date', 'correction_status', 'correction_hours', 'correction_object_id', 'correction_object_name');
        insertVals.push(correction_date, correction_status, correction_hours ?? null, correction_object_id, correctionObjectName);
        insertCasts.push('', '', '', '::uuid', '');
      }
      if (normalizedSelectedDates) {
        insertCols.push('selected_dates');
        insertVals.push(normalizedSelectedDates);
        insertCasts.push('::date[]');
      }
      const placeholders = insertVals.map((_, i) => `$${i + 1}${insertCasts[i] || ''}`).join(', ');

      const insRes = await client.query(
        `INSERT INTO leave_requests (${insertCols.join(', ')})
         VALUES (${placeholders})
         RETURNING *`,
        insertVals,
      );
      const row = insRes.rows[0];
      if (!row) throw new Error('Failed to create leave_request');

      if (attachmentIds.length > 0) {
        const docIds = attachmentIds;
        const entityIds = attachmentIds.map(() => String(row.id));
        const entityTypes = attachmentIds.map(() => 'leave_request');
        const purposes = attachmentIds.map(() => 'leave_request_attachment');

        await client.query(
          `INSERT INTO document_links (document_id, entity_type, entity_id, purpose)
           SELECT u.document_id, u.entity_type, u.entity_id, u.purpose
             FROM unnest($1::bigint[], $2::text[], $3::text[], $4::text[])
               AS u(document_id, entity_type, entity_id, purpose)
           ON CONFLICT (document_id, entity_type, entity_id, purpose) DO NOTHING`,
          [docIds, entityTypes, entityIds, purposes],
        );

        await client.query(
          `UPDATE documents SET leave_request_id = $1
            WHERE id = ANY($2::bigint[]) AND leave_request_id IS NULL`,
          [row.id, docIds],
        );
      }

      return row;
    });

    broadcastPendingChanged();

    // Realtime: инвалидируем списки заявлений у автора и согласующих.
    getLeaveRequestRecipients(employeeId, req.user.id)
      .then((recipients) => {
        emitDomainChange({
          event: 'leave_request:changed',
          targetUserIds: recipients,
          payload: { entityId: data.id, employeeId, action: 'create' },
        });
      })
      .catch((e) => console.error('[leave-requests] emit create realtime error:', e));

    // Уведомляем руководителя отдела и админов (fire-and-forget)
    const label = LEAVE_TYPE_LABELS[request_type] || request_type;
    const dateLabel = formatLeaveDateLabel({
      request_type,
      start_date,
      end_date,
      correction_date: request_type === 'time_correction' ? correction_date : null,
      selected_dates: normalizedSelectedDates,
    });
    const bodyText = `Сотрудник подал заявление: ${label}${dateLabel ? ` (${dateLabel})` : ''}`;
    pushService.sendLeaveRequestNotification(employeeId, request_type, req.user.id, dateLabel)
      .then((recipientIds) => {
        const io = getIo();
        if (io) {
          for (const uid of recipientIds) {
            io.to(`user:${uid}`).emit('leave_request_notification', { requestType: request_type });
          }
        }
        // Сохраняем в БД
        notificationService.createMany(
          recipientIds.map(uid => ({
            userId: uid,
            type: 'leave_request',
            title: 'Новое заявление',
            body: bodyText,
            metadata: { requestType: request_type, employeeId },
          })),
        ).catch((e) => console.error('leave-request notification save error:', e));
      })
      .catch((e) => console.error('leave-request notify error:', e));

    res.json({ success: true, data });
  } catch (err) {
    console.error('leave-requests.create error:', err);
    res.status(500).json({ success: false, error: 'Ошибка создания заявления' });
  }
};

/** Мои заявления (worker) */
const getMy = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const employeeId = req.user.employee_id;
    if (!employeeId) {
      res.json({ success: true, data: [] });
      return;
    }

    const data = await query<{ id: number; request_type: string; status: string; [k: string]: unknown }>(
      `SELECT * FROM leave_requests
        WHERE employee_id = $1
        ORDER BY created_at DESC`,
      [employeeId],
    );
    const correctionRequestIds = data
      .filter(shouldLoadCorrectionApprovalStatus)
      .map(r => Number(r.id))
      .filter(Number.isFinite);
    const correctionStatusMap = await loadCorrectionApprovalStatusByRequestIds(correctionRequestIds);
    const profileMap = await loadDecisionProfiles(data);
    const enriched = data.map(r => ({
      ...withDecisionProfiles(r, profileMap),
      correction_approval_status: correctionStatusMap.get(Number(r.id)) ?? null,
    }));
    res.json({ success: true, data: enriched });
  } catch (err) {
    console.error('leave-requests.getMy error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения заявлений' });
  }
};

/** Объекты, доступные сотруднику для привязки корректировки табеля (worker) */
const getMyObjects = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const employeeId = req.user.employee_id;
    if (!employeeId) {
      res.json({ success: true, data: [] });
      return;
    }
    const data = await listSelectableObjectsForEmployee(employeeId);
    res.json({ success: true, data });
  } catch (err) {
    console.error('leave-requests.getMyObjects error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения объектов' });
  }
};

/**
 * Адресная маршрутизация для списков: оставляет routed-заявки (отпуск/больничный/
 * за свой счёт) только тем, кто их ответственный (назначенный руководитель → иначе
 * начальник отдела). Не-routed типы не трогает. Вызывается только в не-`all` скоупе.
 */
async function filterRoutedVisibility<T extends { employee_id: number; request_type: string }>(
  rows: T[],
  deptByEmp: Map<number, string | null>,
  viewerEmployeeId: number | null,
): Promise<T[]> {
  const routableEmps = [...new Set(
    rows
      .filter(r => ROUTED_LEAVE_TYPES.has(String(r.request_type)))
      .map(r => Number(r.employee_id)),
  )].map(id => ({ employee_id: id, org_department_id: deptByEmp.get(id) ?? null }));
  if (routableEmps.length === 0) return rows;
  const responsibles = await resolveResponsibleEmployeeIdsByEmployee(routableEmps);
  return rows.filter(r => {
    if (!ROUTED_LEAVE_TYPES.has(String(r.request_type))) return true;
    const resp = responsibles.get(Number(r.employee_id)) ?? [];
    return viewerEmployeeId != null && resp.includes(viewerEmployeeId);
  });
}

/**
 * Может ли текущий пользователь действовать над заявкой сотрудника.
 * Админ (scope=all) — всегда. Для routed-типов — только назначенный ответственный
 * (или начальник отдела при отсутствии назначенного). Прочие типы — обычный
 * scope-доступ (`fallback`: 'edit' для approve/reject, 'view' для просмотра).
 */
async function canManageLeaveRequest(
  req: AuthenticatedRequest,
  employeeId: number,
  requestType: string,
  fallback: 'view' | 'edit',
): Promise<boolean> {
  if ((await resolveAccessibleDepartmentIds(req)) === 'all') return true;
  if (ROUTED_LEAVE_TYPES.has(requestType)) {
    const emp = await queryOne<{ org_department_id: string | null }>(
      `SELECT org_department_id FROM employees WHERE id = $1`,
      [employeeId],
    );
    const resp = (await resolveResponsibleEmployeeIdsByEmployee(
      [{ employee_id: employeeId, org_department_id: emp?.org_department_id ?? null }],
    )).get(employeeId) ?? [];
    return req.user.employee_id != null && resp.includes(req.user.employee_id);
  }
  return fallback === 'edit'
    ? canEditEmployeeInScope(req, employeeId)
    : canAccessEmployeeInScope(req, employeeId);
}

/** Заявления отдела (header) */
const getDepartment = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const departmentIds = await resolveManagedDepartmentIds(req);
    const directReportIds = req.user.employee_id
      ? await listDirectSubordinates(req.user.employee_id)
      : [];

    const departmentEmployees = await loadEmployeeIdsByDepartments(departmentIds);
    const departmentEmpIds = new Set(departmentEmployees.map(e => e.id));
    // Direct-reports считаем «непосредственными подчинёнными» только если они НЕ
    // покрыты subtree отделов — иначе показываем их в группе отдела (без дублей).
    const directOnlyIds = directReportIds.filter(id => !departmentEmpIds.has(id));

    const empIds = [...new Set([...departmentEmpIds, ...directOnlyIds])];
    if (empIds.length === 0) {
      res.json({ success: true, data: [] });
      return;
    }

    const data = await query<{ id: number; employee_id: number; request_type: string; status: string; [k: string]: unknown }>(
      `SELECT * FROM leave_requests
        WHERE employee_id = ANY($1::bigint[])
        ORDER BY created_at DESC`,
      [empIds],
    );

    const metaMap = await loadEmployeeMeta(empIds);
    const pendingWorkRequestIds = await loadWorkRequestIdsPendingInApprovals(
      data
        .filter(r => r.request_type === 'work' && r.status === 'pending')
        .map(r => Number(r.id))
        .filter(Number.isFinite),
    );
    const workFiltered = data.filter(r => !isPendingWorkRoutedToApprovals(r, pendingWorkRequestIds));
    // Адресная маршрутизация routed-типов: видит только ответственный.
    const deptByEmp = new Map<number, string | null>(
      [...metaMap.entries()].map(([id, m]) => [id, m.org_department_id]),
    );
    const visibleData = await filterRoutedVisibility(
      workFiltered,
      deptByEmp,
      req.user.employee_id ?? null,
    );
    const requestIds = visibleData.map(r => Number(r.id)).filter(Number.isFinite);
    const attachmentsMap = await loadAttachmentsByLeaveRequestIds(requestIds);
    const correctionRequestIds = visibleData
      .filter(shouldLoadCorrectionApprovalStatus)
      .map(r => Number(r.id))
      .filter(Number.isFinite);
    const correctionStatusMap = await loadCorrectionApprovalStatusByRequestIds(correctionRequestIds);
    const profileMap = await loadDecisionProfiles(visibleData);
    const directOnlySet = new Set(directOnlyIds);

    const enriched = visibleData.map(r => {
      const meta = metaMap.get(r.employee_id);
      return {
        ...withDecisionProfiles(r, profileMap),
        employee_name: meta?.full_name ?? null,
        department_name: meta?.department_name ?? null,
        position_name: meta?.position_name ?? null,
        is_direct_subordinate: directOnlySet.has(Number(r.employee_id)),
        attachments: attachmentsMap.get(Number(r.id)) ?? [],
        correction_approval_status: correctionStatusMap.get(Number(r.id)) ?? null,
      };
    });
    res.json({ success: true, data: enriched });
  } catch (err) {
    console.error('leave-requests.getDepartment error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения заявлений отдела' });
  }
};

/** Все заявления организации (hr/admin) */
const getAll = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const isAllScope = (await resolveAccessibleDepartmentIds(req)) === 'all';
    const scopedDepartmentId = await resolveScopedDepartmentId(req, null);
    const managedDepartmentIds = await resolveManagedDepartmentIds(req);
    const directReportIds = req.user.employee_id
      ? await listDirectSubordinates(req.user.employee_id)
      : [];

    const whereParts: string[] = [];
    const params: unknown[] = [];
    const addParam = (v: unknown): string => {
      params.push(v);
      return `$${params.length}`;
    };

    const status = req.query.status as string | undefined;
    if (status) {
      whereParts.push(`status = ${addParam(status)}`);
    }

    let directOnlySet = new Set<number>();
    if (managedDepartmentIds.length > 0 || directReportIds.length > 0) {
      const employees = scopedDepartmentId
        ? await loadEmployeeIdsByDepartment(scopedDepartmentId)
        : await loadEmployeeIdsByDepartments(managedDepartmentIds);
      const departmentEmpIds = new Set(employees.map(e => e.id));
      // При scopedDepartmentId (admin фильтрует один отдел) direct-reports не
      // расширяют выборку — это явный фильтр пользователя на отдел.
      const directOnlyIds = scopedDepartmentId
        ? []
        : directReportIds.filter(id => !departmentEmpIds.has(id));
      directOnlySet = new Set(directOnlyIds);
      const employeeIds = [...new Set([...departmentEmpIds, ...directOnlyIds])];
      if (employeeIds.length === 0) {
        res.json({ success: true, data: [] });
        return;
      }
      whereParts.push(`employee_id = ANY(${addParam(employeeIds)}::bigint[])`);
    }

    const whereSql = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';

    const data = await query<{ id: number; employee_id: number; request_type: string; status: string; [k: string]: unknown }>(
      `SELECT * FROM leave_requests
        ${whereSql}
        ORDER BY created_at DESC`,
      params,
    );

    const empIds = [...new Set(data.map(r => r.employee_id))];
    const metaMap = await loadEmployeeMeta(empIds);
    const pendingWorkRequestIds = await loadWorkRequestIdsPendingInApprovals(
      data
        .filter(r => r.request_type === 'work' && r.status === 'pending')
        .map(r => Number(r.id))
        .filter(Number.isFinite),
    );
    const workFiltered = data.filter(r => !isPendingWorkRoutedToApprovals(r, pendingWorkRequestIds));
    // Админ (scope=all) видит всё; ограниченный скоуп — адресная маршрутизация routed-типов.
    const visibleData = isAllScope
      ? workFiltered
      : await filterRoutedVisibility(
          workFiltered,
          new Map([...metaMap.entries()].map(([id, m]) => [id, m.org_department_id])),
          req.user.employee_id ?? null,
        );
    const requestIds = visibleData.map(r => Number(r.id)).filter(Number.isFinite);
    const attachmentsMap = await loadAttachmentsByLeaveRequestIds(requestIds);
    const correctionRequestIds = visibleData
      .filter(shouldLoadCorrectionApprovalStatus)
      .map(r => Number(r.id))
      .filter(Number.isFinite);
    const correctionStatusMap = await loadCorrectionApprovalStatusByRequestIds(correctionRequestIds);
    const profileMap = await loadDecisionProfiles(visibleData);

    const enriched = visibleData.map(r => {
      const meta = metaMap.get(r.employee_id);
      return {
        ...withDecisionProfiles(r, profileMap),
        employee_name: meta?.full_name ?? null,
        department_name: meta?.department_name ?? null,
        position_name: meta?.position_name ?? null,
        is_direct_subordinate: directOnlySet.has(Number(r.employee_id)),
        attachments: attachmentsMap.get(Number(r.id)) ?? [],
        correction_approval_status: correctionStatusMap.get(Number(r.id)) ?? null,
      };
    });
    res.json({ success: true, data: enriched });
  } catch (err) {
    console.error('leave-requests.getAll error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения заявлений' });
  }
};

/** Количество pending-заявлений в scope текущего юзера (для бейджа в меню) */
const pendingCount = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const accessible = await resolveAccessibleDepartmentIds(req);

    if (accessible === 'all') {
      const row = await queryOne<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM leave_requests lr
          WHERE lr.status = 'pending'
            AND NOT (
              lr.request_type = 'work'
              AND EXISTS (
                SELECT 1
                  FROM attendance_adjustments aa
                 WHERE aa.source_type = 'leave_request'
                   AND aa.source_id = lr.id::text
                   AND aa.approval_status = 'pending'
              )
            )`,
      );
      res.json({ success: true, data: { count: Number(row?.count ?? 0) } });
      return;
    }

    const directReportIds = req.user.employee_id
      ? await listDirectSubordinates(req.user.employee_id)
      : [];

    if (accessible.length === 0 && directReportIds.length === 0) {
      res.json({ success: true, data: { count: 0 } });
      return;
    }

    const rows = await query<{ id: number; employee_id: number; request_type: string; org_department_id: string | null }>(
      `SELECT lr.id, lr.employee_id, lr.request_type, e.org_department_id
         FROM leave_requests lr
         JOIN employees e ON e.id = lr.employee_id
        WHERE lr.status = 'pending'
          AND NOT (
            lr.request_type = 'work'
            AND EXISTS (
              SELECT 1
                FROM attendance_adjustments aa
               WHERE aa.source_type = 'leave_request'
                 AND aa.source_id = lr.id::text
                 AND aa.approval_status = 'pending'
            )
          )
          AND (
                e.org_department_id = ANY($1::uuid[])
             OR lr.employee_id      = ANY($2::bigint[])
              )`,
      [accessible, directReportIds],
    );
    // Бейдж совпадает с видимым в getDepartment: адресная маршрутизация routed-типов.
    const deptByEmp = new Map<number, string | null>(
      rows.map(r => [Number(r.employee_id), r.org_department_id]),
    );
    const visible = await filterRoutedVisibility(rows, deptByEmp, req.user.employee_id ?? null);
    res.json({ success: true, data: { count: visible.length } });
  } catch (err) {
    console.error('leave-requests.pendingCount error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения счётчика заявлений' });
  }
};

/** Получение одной заявки по ID (автор + ревьюер с правами) */
const getById = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    const request = await queryOne<{
      employee_id: number;
      reviewer_id: string | null;
      request_type: string;
      status: string;
      [k: string]: unknown;
    }>(
      `SELECT * FROM leave_requests WHERE id = $1`,
      [id],
    );

    if (!request) {
      res.status(404).json({ success: false, error: 'Заявление не найдено' });
      return;
    }

    const isOwner = request.employee_id === req.user.employee_id;
    const canReviewOthers = await canManageLeaveRequest(req, request.employee_id, request.request_type, 'view');
    if (!isOwner && !canReviewOthers) {
      res.status(403).json({ success: false, error: 'Нет доступа к заявке' });
      return;
    }

    // ФИО сотрудника
    const emp = await queryOne<{ id: number; full_name: string | null }>(
      `SELECT id, full_name FROM employees WHERE id = $1`,
      [request.employee_id],
    );

    // Данные согласовавшего и отменившего
    const profileMap = await loadDecisionProfiles([request]);

    let correctionApprovalStatus: string | null = null;
    if (shouldLoadCorrectionApprovalStatus(request)) {
      const statusMap = await loadCorrectionApprovalStatusByRequestIds([Number(id)]);
      correctionApprovalStatus = statusMap.get(Number(id)) ?? null;
    }

    res.json({
      success: true,
      data: {
        ...withDecisionProfiles(request, profileMap),
        employee_name: emp?.full_name ?? null,
        correction_approval_status: correctionApprovalStatus,
      },
    });
  } catch (err) {
    console.error('leave-requests.getById error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения заявки' });
  }
};

/** Одобрение заявления */
const approve = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { comment } = req.body;

    // Проверяем заявление
    const request = await queryOne<{
      id: number;
      employee_id: number;
      status: string;
      request_type: string;
      start_date: string;
      end_date: string;
      correction_date: string | null;
      correction_status: string | null;
      correction_hours: number | null;
      correction_object_id: string | null;
      correction_object_name: string | null;
      selected_dates: string[] | null;
      reason: string | null;
    }>(
      `SELECT * FROM leave_requests WHERE id = $1`,
      [id],
    );

    if (!request) {
      res.status(404).json({ success: false, error: 'Заявление не найдено' });
      return;
    }

    if (request.status !== 'pending') {
      res.status(400).json({ success: false, error: 'Заявление уже обработано' });
      return;
    }

    if (!(await canManageLeaveRequest(req, request.employee_id, request.request_type, 'edit'))) {
      res.status(403).json({ success: false, error: 'Нет доступа к заявлениям сотрудника' });
      return;
    }

    // Валидация периода ДО транзакции: битые легаси-заявки (напр. год 0026 → span
    // ~730к дней) иначе подвесили бы материализацию. Явный 400 — внешний catch иначе
    // превратил бы throw в 500, а транзакция/upsert не должны стартовать вовсе.
    const periodCheck = validateLeaveRequestPeriod(request.start_date, request.end_date, request.selected_dates);
    if (!periodCheck.ok) {
      res.status(400).json({ success: false, error: `Некорректный период заявления: ${periodCheck.error}` });
      return;
    }

    // Автором корректировки в табеле должен быть сам сотрудник-заявитель,
    // а не одобряющий руководитель. Резолвим его user_profiles.id по employee_id.
    const author = await queryOne<{ id: string }>(
      `SELECT id FROM user_profiles WHERE employee_id = $1 LIMIT 1`,
      [request.employee_id],
    );
    const authorUserId = author?.id ?? req.user.id;

    // Автосхлопывание 2-го этапа: если одобряющий сам является ответственным
    // за выходные этого сотрудника («Назначение сотрудников» → «Выходные»),
    // его одобрение закрывает оба этапа — корректировки выходных создаются
    // сразу approved и не попадают в очередь /approvals.
    let weekendCollapseApproverUserId: string | null = null;
    if (req.user.employee_id != null) {
      const empDept = await queryOne<{ org_department_id: string | null }>(
        `SELECT org_department_id FROM employees WHERE id = $1`,
        [request.employee_id],
      );
      const weekendResponsible = await resolveResponsibleEmployeeForTarget(
        request.employee_id,
        empDept?.org_department_id ?? null,
      );
      if (weekendResponsible != null && weekendResponsible === req.user.employee_id) {
        weekendCollapseApproverUserId = req.user.id;
      }
    }

    const nowIso = new Date().toISOString();

    // Атомарность: смена статуса и материализация корректировок в одной транзакции.
    // Раньше status='approved' проставлялся ДО создания adjustment'ов и вне транзакции —
    // при сбое вставки заявка оставалась одобренной без строк в табеле (осиротевшие
    // approved-заявки). Теперь падение отката → заявка остаётся pending, запрос ретраится.
    const result = await withTransaction(async (client) => {
      // Анти-гонка: статус мог смениться после проверки выше (сотрудник отменил заявление
      // параллельно). Обновляем только pending — иначе откатываемся и НЕ материализуем
      // корректировки, иначе они остались бы сиротами при отменённой заявке.
      const updated = (await client.query(
        `UPDATE leave_requests SET
           status = 'approved',
           reviewer_id = $1,
           reviewed_at = $2,
           review_comment = $3,
           updated_at = $2
         WHERE id = $4 AND status = 'pending'
         RETURNING *`,
        [req.user.id, nowIso, comment || null, id],
      )).rows[0] ?? null;

      if (!updated) return { conflict: true as const };

      // Создаём attendance adjustments как канонический источник ручных статусов.
      // Для work/remote в выходной approval_status считает единый резолвер.
      await materializeLeaveRequestAdjustments(request, authorUserId, client, weekendCollapseApproverUserId);

      // Обработка корректировки табеля
      if (request.request_type === 'time_correction' && request.correction_date) {
        const rawCorrectionStatus: TimeStatus = isTimeStatus(request.correction_status) ? request.correction_status : 'work';
        // Явные часы на «рабочий день» = «Корректировка табеля» (manual): время авторитетно
        // берётся из hours_override, а не из СКУД. Иначе при отсутствии проходов время «терялось»
        // (status='work' + null часов → 0 по СКУД), и статус расходился со списком корректировок.
        const correctionStatus: TimeStatus = rawCorrectionStatus === 'work' && (request.correction_hours ?? 0) > 0
          ? 'manual'
          : rawCorrectionStatus;
        // Если день — выходной по графику сотрудника И его отдел в whitelist
        // настройки «Согласование выходных дней», корректировка попадает в pending
        // и должна быть дополнительно одобрена админом на /approvals.
        // Исключение — схлопывание: одобряющий сам ответственный за выходные.
        const resolvedApproval = await resolveAdjustmentApprovalStatus(
          request.employee_id,
          request.correction_date,
          correctionStatus,
          request.correction_hours ?? null,
        );
        const collapsed = resolvedApproval === 'pending' && weekendCollapseApproverUserId != null;
        const approvalStatus = collapsed ? ('approved' as const) : resolvedApproval;
        const approvedBy = collapsed ? weekendCollapseApproverUserId : undefined;
        if (request.correction_object_id) {
          // Корректировка привязана к конкретному объекту → создаём manual_object
          // (как табель руководителя), а не day-level «Не определён». Снимаем конфликтующие
          // day-level записи дня (мьютекс day-level ↔ per-object).
          await client.query(
            `DELETE FROM attendance_adjustments
               WHERE employee_id = $1 AND work_date = $2
                 AND source_type IN ('manual', 'leave_request')`,
            [request.employee_id, request.correction_date],
          );
          await upsertAttendanceAdjustment({
            employee_id: request.employee_id,
            work_date: request.correction_date,
            status: correctionStatus,
            hours_override: request.correction_hours ?? null,
            source_type: OBJECT_ADJUSTMENT_SOURCE_TYPE,
            source_id: request.correction_object_id,
            reason: request.reason ?? null,
            created_by: authorUserId,
            approval_status: approvalStatus,
            approved_by: approvedBy,
            metadata: {
              object_id: request.correction_object_id,
              object_name: request.correction_object_name,
              auto_resolved: false,
            },
          }, client);
        } else {
          // Легаси-заявки без объекта (созданные до миграции 158): day-level как раньше.
          await upsertAttendanceAdjustment({
            employee_id: request.employee_id,
            work_date: request.correction_date,
            status: correctionStatus,
            hours_override: request.correction_hours ?? null,
            source_type: 'leave_request',
            source_id: `${request.id}:time_correction`,
            reason: request.reason ?? null,
            created_by: authorUserId,
            approval_status: approvalStatus,
            approved_by: approvedBy,
          }, client);
        }
      }

      return { conflict: false as const, row: updated };
    });

    if (result.conflict) {
      res.status(409).json({ success: false, error: 'Статус заявления изменился, обновите страницу' });
      return;
    }

    broadcastPendingChanged();

    // Realtime: статус заявки изменился — синхронизируем автору и остальным approvers.
    getLeaveRequestRecipients(request.employee_id, req.user.id)
      .then((recipients) => {
        emitDomainChange({
          event: 'leave_request:changed',
          targetUserIds: recipients,
          payload: { entityId: request.id, employeeId: request.employee_id, action: 'approve' },
        });
      })
      .catch((e) => console.error('[leave-requests] emit approve realtime error:', e));

    res.json({ success: true, data: result.row });
  } catch (err) {
    console.error('leave-requests.approve error:', err);
    res.status(500).json({ success: false, error: 'Ошибка одобрения заявления' });
  }
};

/** Отклонение заявления */
const reject = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { comment } = req.body;

    const request = await queryOne<{ id: number; employee_id: number; status: string; request_type: string }>(
      `SELECT * FROM leave_requests WHERE id = $1`,
      [id],
    );

    if (!request) {
      res.status(404).json({ success: false, error: 'Заявление не найдено' });
      return;
    }

    if (request.status !== 'pending') {
      res.status(400).json({ success: false, error: 'Заявление уже обработано' });
      return;
    }

    if (!(await canManageLeaveRequest(req, request.employee_id, request.request_type, 'edit'))) {
      res.status(403).json({ success: false, error: 'Нет доступа к заявлениям сотрудника' });
      return;
    }

    const nowIso = new Date().toISOString();
    // Анти-гонка: статус мог смениться после проверки выше (самоотмена сотрудником).
    const data = await queryOne(
      `UPDATE leave_requests SET
         status = 'rejected',
         reviewer_id = $1,
         reviewed_at = $2,
         review_comment = $3,
         updated_at = $2
       WHERE id = $4 AND status = 'pending'
       RETURNING *`,
      [req.user.id, nowIso, comment || null, id],
    );

    if (!data) {
      res.status(409).json({ success: false, error: 'Статус заявления изменился, обновите страницу' });
      return;
    }

    broadcastPendingChanged();

    // Realtime: статус заявки изменился — синхронизируем автору и остальным approvers.
    getLeaveRequestRecipients(request.employee_id, req.user.id)
      .then((recipients) => {
        emitDomainChange({
          event: 'leave_request:changed',
          targetUserIds: recipients,
          payload: { entityId: request.id, employeeId: request.employee_id, action: 'reject' },
        });
      })
      .catch((e) => console.error('[leave-requests] emit reject realtime error:', e));

    res.json({ success: true, data });
  } catch (err) {
    console.error('leave-requests.reject error:', err);
    res.status(500).json({ success: false, error: 'Ошибка отклонения заявления' });
  }
};

/**
 * Правка текста обоснования заявления руководителем/админом (например, дописать
 * пропущенный объект). Разрешена независимо от статуса заявления и от того,
 * заперты ли по периоду какие-то из материализованных дней — см.
 * syncLeaveRequestReason: leave_requests.reason обновляется всегда, копии в
 * attendance_adjustments — только для незапертых дней.
 */
const updateReason = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { reason } = req.body as { reason?: unknown };

    if (typeof reason !== 'string') {
      res.status(400).json({ success: false, error: 'Текст заявления обязателен' });
      return;
    }
    const trimmedReason = reason.trim();
    if (trimmedReason.length > 500) {
      res.status(400).json({ success: false, error: 'Текст заявления не может быть длиннее 500 символов' });
      return;
    }

    const request = await queryOne<{ id: number; employee_id: number; request_type: string }>(
      `SELECT * FROM leave_requests WHERE id = $1`,
      [id],
    );
    if (!request) {
      res.status(404).json({ success: false, error: 'Заявление не найдено' });
      return;
    }

    if (!(await canManageLeaveRequest(req, request.employee_id, request.request_type, 'edit'))) {
      res.status(403).json({ success: false, error: 'Нет доступа к заявлениям сотрудника' });
      return;
    }

    await syncLeaveRequestReason(Number(id), trimmedReason || null);

    const data = await queryOne(`SELECT * FROM leave_requests WHERE id = $1`, [id]);

    auditService.logFromRequest(req, req.user.id, 'UPDATE_LEAVE_REQUEST_REASON', {
      entityType: 'leave_request',
      entityId: String(id),
      details: { employee_id: request.employee_id, reason: trimmedReason },
    }).catch((e) => console.error('[leave-requests] audit updateReason error:', e));

    res.json({ success: true, data });
  } catch (err) {
    console.error('leave-requests.updateReason error:', err);
    res.status(500).json({ success: false, error: 'Ошибка правки текста заявления' });
  }
};

/** Отмена заявления автором (статусы pending или approved). Откатываем
 *  материализованные строки attendance_adjustments в той же транзакции.
 *  Для отпусков причина обязательна — отдел кадров должен видеть, почему отпуск отменён.
 *  След: cancelled_by/at/reason + cancel_source='employee' (в отличие от revokeApproval). */
const cancel = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const reasonRaw = req.body?.reason;
    const reason = typeof reasonRaw === 'string' && reasonRaw.trim() ? reasonRaw.trim() : null;

    if (reason && reason.length > CANCEL_REASON_MAX_LENGTH) {
      res.status(400).json({ success: false, error: `Причина не может быть длиннее ${CANCEL_REASON_MAX_LENGTH} символов` });
      return;
    }

    const request = await queryOne<{ id: number; employee_id: number; status: string; request_type: string }>(
      `SELECT * FROM leave_requests WHERE id = $1`,
      [id],
    );

    if (!request) {
      res.status(404).json({ success: false, error: 'Заявление не найдено' });
      return;
    }

    if (request.status !== 'pending' && request.status !== 'approved') {
      res.status(400).json({ success: false, error: 'Нельзя отменить отклонённое или уже отменённое заявление' });
      return;
    }

    if (request.employee_id !== req.user.employee_id) {
      res.status(403).json({ success: false, error: 'Можно отменить только своё заявление' });
      return;
    }

    if (!reason && VACATION_REQUEST_TYPES.includes(request.request_type)) {
      res.status(400).json({ success: false, error: 'Укажите причину отмены отпуска' });
      return;
    }

    const nowIso = new Date().toISOString();
    const result = await withTransaction(async (client) => {
      // Анти-гонка: блокируем строку и повторно проверяем статус/владельца внутри
      // транзакции — руководитель мог согласовать или отклонить заявление параллельно.
      const locked = await client.query<{ status: string; employee_id: number }>(
        `SELECT status, employee_id FROM leave_requests WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const current = locked.rows[0];
      if (!current || (current.status !== 'pending' && current.status !== 'approved')) {
        return { conflict: true as const };
      }
      if (current.employee_id !== req.user.employee_id) {
        return { forbidden: true as const };
      }
      const updated = await client.query(
        `UPDATE leave_requests SET status = 'cancelled',
                cancelled_by = $3, cancelled_at = $1, cancel_reason = $4,
                cancel_source = 'employee', updated_at = $1
          WHERE id = $2
          RETURNING *`,
        [nowIso, id, req.user.id, reason],
      );
      // Чистим корректировки и для pending-заявок: легаси work-заявки могли
      // материализовать pending-строки ещё при создании — без удаления они
      // остались бы сиротами в очереди /approvals.
      await client.query(
        `DELETE FROM attendance_adjustments
           WHERE source_type = 'leave_request'
             AND source_id = ANY($1::text[])`,
        [[String(id), `${id}:time_correction`]],
      );
      return { conflict: false as const, row: updated.rows[0] ?? null };
    });

    if ('forbidden' in result) {
      res.status(403).json({ success: false, error: 'Можно отменить только своё заявление' });
      return;
    }
    if (result.conflict) {
      res.status(409).json({ success: false, error: 'Статус заявления изменился, обновите страницу' });
      return;
    }

    const profileMap = await loadDecisionProfiles([result.row ?? {}]);
    const data = result.row ? withDecisionProfiles(result.row, profileMap) : null;

    broadcastPendingChanged();

    // Realtime: заявка отменена автором — синхронизируем самому автору и approvers.
    getLeaveRequestRecipients(request.employee_id, req.user.id)
      .then((recipients) => {
        emitDomainChange({
          event: 'leave_request:changed',
          targetUserIds: recipients,
          payload: { entityId: request.id, employeeId: request.employee_id, action: 'cancel' },
        });
      })
      .catch((e) => console.error('[leave-requests] emit cancel realtime error:', e));

    res.json({ success: true, data });
  } catch (err) {
    console.error('leave-requests.cancel error:', err);
    res.status(500).json({ success: false, error: 'Ошибка отмены заявления' });
  }
};

/**
 * Отпуска для вкладки «Отпуска» (только админ + отдел кадров, гейт по /leave-vacations).
 * Показываем заявления типов vacation/unpaid/educational_leave всех сотрудников,
 * КРОМЕ рабочих. «Рабочий» определяется по системной роли аккаунта сотрудника
 * (system_roles.code = 'worker'): positions.category на проде не заполнен (всё 'other'),
 * поэтому фильтр по должности недостоверен. Все статусы. Скоуп отделов намеренно
 * не применяем — отдел кадров видит организацию целиком.
 */
const getVacations = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const status = req.query.status as string | undefined;
    const params: unknown[] = [VACATION_REQUEST_TYPES];
    let statusSql = '';
    if (status) {
      params.push(status);
      statusSql = ` AND lr.status = $${params.length}`;
    }

    const data = await query<{ id: number; employee_id: number; request_type: string; status: string; reviewer_id: string | null; [k: string]: unknown }>(
      `SELECT lr.*,
              e.full_name           AS employee_name,
              e.org_department_id   AS org_department_id,
              od.name               AS department_name,
              p.name                AS position_name
         FROM leave_requests lr
         JOIN employees e             ON e.id = lr.employee_id
         LEFT JOIN org_departments od ON od.id = e.org_department_id
         LEFT JOIN positions p        ON p.id = e.position_id
        WHERE lr.request_type = ANY($1::text[])
          AND NOT EXISTS (
                SELECT 1 FROM user_profiles up
                  JOIN system_roles sr ON sr.id = up.system_role_id
                 WHERE up.employee_id = e.id AND sr.code = 'worker'
              )${statusSql}
        ORDER BY lr.created_at DESC`,
      params,
    );

    const requestIds = data.map(r => Number(r.id)).filter(Number.isFinite);
    const attachmentsMap = await loadAttachmentsByLeaveRequestIds(requestIds);
    const profileMap = await loadDecisionProfiles(data);

    const enriched = data.map(r => ({
      ...withDecisionProfiles(r, profileMap),
      attachments: attachmentsMap.get(Number(r.id)) ?? [],
    }));
    res.json({ success: true, data: enriched });
  } catch (err) {
    console.error('leave-requests.getVacations error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения отпусков' });
  }
};

/**
 * Отметка «Отдел кадров ознакомлен» по заявлению на отпуск (админ + отдел кадров).
 * Идемпотентно: COALESCE фиксирует первую отметку и не перетирает её повторными кликами.
 * Realtime синхронизирует галочку сотруднику в ЛК и его руководителю.
 */
const hrAcknowledge = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    const request = await queryOne<{ id: number; employee_id: number; request_type: string }>(
      `SELECT id, employee_id, request_type FROM leave_requests WHERE id = $1`,
      [id],
    );
    if (!request) {
      res.status(404).json({ success: false, error: 'Заявление не найдено' });
      return;
    }
    if (!VACATION_REQUEST_TYPES.includes(request.request_type)) {
      res.status(400).json({ success: false, error: 'Отметка доступна только для отпусков' });
      return;
    }

    const nowIso = new Date().toISOString();
    const data = await queryOne(
      `UPDATE leave_requests SET
         hr_acknowledged_at = COALESCE(hr_acknowledged_at, $2),
         hr_acknowledged_by = COALESCE(hr_acknowledged_by, $1),
         updated_at = $2
       WHERE id = $3
       RETURNING *`,
      [req.user.id, nowIso, id],
    );

    // Realtime: сотрудник и его руководитель видят отметку без перезагрузки.
    getLeaveRequestRecipients(request.employee_id, req.user.id)
      .then((recipients) => {
        emitDomainChange({
          event: 'leave_request:changed',
          targetUserIds: recipients,
          payload: { entityId: request.id, employeeId: request.employee_id, action: 'hr_acknowledge' },
        });
      })
      .catch((e) => console.error('[leave-requests] emit hr_acknowledge realtime error:', e));

    res.json({ success: true, data });
  } catch (err) {
    console.error('leave-requests.hrAcknowledge error:', err);
    res.status(500).json({ success: false, error: 'Ошибка отметки об ознакомлении' });
  }
};

/**
 * Затрагиваемые отпуском даты (YYYY-MM-DD, отсортированы): `selected_dates`
 * приоритетнее диапазона. Для непрерывного отпуска разворачиваем start..end.
 * Используется и для проверки «строго в будущем», и для гарда закрытого табеля.
 */
function collectLeaveRequestDates(r: { start_date: string; end_date: string; selected_dates: string[] | null }): string[] {
  if (Array.isArray(r.selected_dates) && r.selected_dates.length > 0) {
    return [...new Set(r.selected_dates)].sort();
  }
  const out: string[] = [];
  const [sy, sm, sd] = r.start_date.split('-').map(Number);
  const [ey, em, ed] = r.end_date.split('-').map(Number);
  let t = Date.UTC(sy, sm - 1, sd);
  const end = Date.UTC(ey, em - 1, ed);
  for (let guard = 0; t <= end && guard < 400; guard++, t += 86_400_000) {
    const d = new Date(t);
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`);
  }
  return out;
}

/**
 * Управленческая отмена СОГЛАСОВАННОГО отпуска (admin или согласовавший руководитель).
 * Иной смысл, чем у самоотмены сотрудника (`cancel`): откат принятого решения.
 *  - типы: только vacation/unpaid/educational_leave; статус: только approved;
 *  - право (источник истины): is_admin || reviewer_id === req.user.id;
 *  - руководитель — только если ВСЕ даты строго в будущем (Europe/Moscow);
 *  - закрытый/сданный табель (submitted/approved по снапшоту состава) → 409, ничего не трогаем;
 *  - откат табеля — тем же точечным DELETE, что и `cancel` (для отпусков он полный);
 *  - след: cancelled_by/at/reason; reviewer_id НЕ трогаем; сотрудник получает уведомление.
 */
const revokeApproval = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const reasonRaw = req.body?.reason;
    const reason = typeof reasonRaw === 'string' && reasonRaw.trim() ? reasonRaw.trim() : null;

    const request = await queryOne<{
      id: number; employee_id: number; request_type: string; status: string;
      reviewer_id: string | null; start_date: string; end_date: string; selected_dates: string[] | null;
    }>(`SELECT * FROM leave_requests WHERE id = $1`, [id]);

    if (!request) {
      res.status(404).json({ success: false, error: 'Заявление не найдено' });
      return;
    }
    if (!VACATION_REQUEST_TYPES.includes(request.request_type)) {
      res.status(400).json({ success: false, error: 'Отмена доступна только для отпусков' });
      return;
    }
    if (request.status !== 'approved') {
      res.status(400).json({ success: false, error: 'Отменить можно только согласованное заявление' });
      return;
    }

    const isAdmin = !!req.user.is_admin;
    const isApprover = !!request.reviewer_id && req.user.id === request.reviewer_id;
    if (!isAdmin && !isApprover) {
      res.status(403).json({ success: false, error: 'Отменить согласованный отпуск может только администратор или согласовавший руководитель' });
      return;
    }

    const dates = collectLeaveRequestDates(request);
    const minDate = dates[0];

    // Руководитель — только полностью будущий отпуск. Админ может и начавшийся/прошедший.
    if (!isAdmin && !(minDate && minDate > moscowTodayIso())) {
      res.status(400).json({ success: false, error: 'Руководитель может отменить только отпуск, который ещё не начался' });
      return;
    }

    // Жёсткий гард: ни одна дата не должна попадать в уже сданный/одобренный табель.
    // Членство берём из снапшота состава подачи (timesheet_approval_employees) — не из
    // org_department_id (членство снапшотное). У руководителя не срабатывает (даты будущие).
    if (dates.length > 0) {
      const locked = await query<{ ok: number }>(
        `SELECT 1 AS ok
           FROM unnest($2::date[]) AS d(work_date)
           JOIN timesheet_approvals a
             ON a.start_date <= d.work_date AND a.end_date >= d.work_date
           JOIN timesheet_approval_employees s
             ON s.approval_id = a.id AND s.employee_id = $1
          WHERE a.status IN ('submitted','approved')
          LIMIT 1`,
        [request.employee_id, dates],
      );
      if (locked.length > 0) {
        res.status(409).json({ success: false, error: 'Период уже сдан/закрыт в табеле — сначала верните табель на доработку' });
        return;
      }
    }

    const nowIso = new Date().toISOString();
    const result = await withTransaction(async (client) => {
      // Анти-гонка: блокируем строку и повторно проверяем статус внутри транзакции.
      const locked = await client.query<{ status: string }>(
        `SELECT status FROM leave_requests WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const current = locked.rows[0];
      if (!current || current.status !== 'approved') {
        return { conflict: true as const };
      }
      // Источник отмены: согласовавший — 'manager', иначе (админ, который не согласовывал) — 'admin'.
      const cancelSource = isApprover ? 'manager' : 'admin';
      const updated = await client.query(
        `UPDATE leave_requests SET status = 'cancelled',
                cancelled_by = $1, cancelled_at = $2, cancel_reason = $3,
                cancel_source = $5, updated_at = $2
          WHERE id = $4
          RETURNING *`,
        [req.user.id, nowIso, reason, id, cancelSource],
      );
      // Точечный откат табеля — ровно строки этого заявления (как в cancel). Шире не трогаем.
      await client.query(
        `DELETE FROM attendance_adjustments
           WHERE source_type = 'leave_request'
             AND source_id = ANY($1::text[])`,
        [[String(id), `${id}:time_correction`]],
      );
      return { conflict: false as const, row: updated.rows[0] ?? null };
    });

    if (result.conflict) {
      res.status(409).json({ success: false, error: 'Статус заявления изменился, обновите страницу' });
      return;
    }

    broadcastPendingChanged();

    // Realtime: автор, его руководитель и инициатор отмены.
    getLeaveRequestRecipients(request.employee_id, req.user.id)
      .then((recipients) => {
        emitDomainChange({
          event: 'leave_request:changed',
          targetUserIds: recipients,
          payload: { entityId: request.id, employeeId: request.employee_id, action: 'revoke' },
        });
      })
      .catch((e) => console.error('[leave-requests] emit revoke realtime error:', e));

    // Уведомление сотруднику (обязательно): согласованный отпуск отменён.
    const employeeUserId = await getEmployeeUserId(request.employee_id);
    if (employeeUserId) {
      const label = LEAVE_TYPE_LABELS[request.request_type] || request.request_type;
      const dateLabel = formatLeaveDateLabel({
        request_type: request.request_type,
        start_date: request.start_date,
        end_date: request.end_date,
        correction_date: null,
        selected_dates: request.selected_dates,
      });
      const body = `Согласованный отпуск отменён: ${label}${dateLabel ? ` (${dateLabel})` : ''}${reason ? `. Причина: ${reason}` : ''}`;
      notificationService.createMany([{
        userId: employeeUserId,
        type: 'leave_request',
        title: 'Отпуск отменён',
        body,
        metadata: { requestType: request.request_type, employeeId: request.employee_id, action: 'revoke' },
      }]).catch((e) => console.error('[leave-requests] revoke notification save error:', e));
      pushService.sendGenericNotification([employeeUserId], 'Отпуск отменён', body, { path: '/employee/requests' })
        .catch((e) => console.error('[leave-requests] revoke push error:', e));
    }

    const profileMap = await loadDecisionProfiles([result.row ?? {}]);
    res.json({ success: true, data: result.row ? withDecisionProfiles(result.row, profileMap) : null });
  } catch (err) {
    console.error('leave-requests.revokeApproval error:', err);
    res.status(500).json({ success: false, error: 'Ошибка отмены согласованного отпуска' });
  }
};

export const leaveRequestsController = {
  create,
  getMy,
  getMyObjects,
  getById,
  getDepartment,
  getAll,
  getVacations,
  pendingCount,
  approve,
  reject,
  updateReason,
  cancel,
  hrAcknowledge,
  revokeApproval,
};
