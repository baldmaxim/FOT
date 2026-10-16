// Список для вкладки «Отпуска»: карточки отпусков корректировкой, снятые после
// ознакомления дни и отказы кадров (миграция 311). Источник карточек — loadVisibleDays.

import type { DbExecutor } from '../config/postgres.js';
import {
  CORRECTION_LEAVE_CUTOFF,
  groupVisibleDays,
  isDayAcked,
  loadDayStates,
  loadVisibleDays,
  normalizeDayState,
  type CorrectionLeaveStatus,
  type IDayHrState,
} from './correction-leave.service.js';

export interface IHrCorrectionAttachment {
  id: number;
  file_name: string;
  mime_type: string | null;
  file_size: number | null;
}

interface IHrItemBase {
  key: string;
  employee_id: number;
  employee_name: string | null;
  department_name: string | null;
  position_name: string | null;
  leave_status: CorrectionLeaveStatus;
  start_date: string;
  end_date: string;
  days: string[];
  author_name: string | null;
  last_changed_at: string;
  hr_acknowledged_at: string | null;
  hr_acknowledged_by_name: string | null;
}

export interface IHrCorrectionLeaveItem extends IHrItemBase {
  kind: 'correction';
  adjustment_ids: number[];
  version: string;
  reason: string | null;
  attachments: IHrCorrectionAttachment[];
}

export interface IHrCorrectionRemovedItem extends IHrItemBase {
  kind: 'removed';
  adjustment_ids: number[];
  removed_kind: 'deleted' | 'status_changed' | 'mixed';
  removed_at: string;
}

export interface IHrCorrectionRejectedItem extends IHrItemBase {
  kind: 'rejected';
  id: number;
  reason: string | null;
  rejected_at: string;
  rejected_by_name: string | null;
  reject_reason: string;
}

export type HrCorrectionItem = IHrCorrectionLeaveItem | IHrCorrectionRemovedItem | IHrCorrectionRejectedItem;

/** Сколько дней «Ознакомлен» хранит отмеченные снятия во вкладке. */
const SEEN_REMOVED_KEEP_DAYS = 90;

interface IEmployeeInfo { full_name: string | null; department_name: string | null; position_name: string | null }

const loadEmployees = async (exec: DbExecutor, ids: number[]): Promise<Map<number, IEmployeeInfo>> => {
  if (ids.length === 0) return new Map();
  const res = await exec.query<IEmployeeInfo & { id: number }>(
    `SELECT e.id, e.full_name, od.name AS department_name, p.name AS position_name
       FROM employees e
       LEFT JOIN org_departments od ON od.id = e.org_department_id
       LEFT JOIN positions p ON p.id = e.position_id
      WHERE e.id = ANY($1::int[])`,
    [ids],
  );
  return new Map(res.rows.map(row => [Number(row.id), row]));
};

const loadProfileNames = async (exec: DbExecutor, ids: Array<string | null>): Promise<Map<string, string>> => {
  const unique = [...new Set(ids.filter((id): id is string => !!id))];
  if (unique.length === 0) return new Map();
  const res = await exec.query<{ id: string; full_name: string | null }>(
    'SELECT id, full_name FROM user_profiles WHERE id = ANY($1::uuid[])',
    [unique],
  );
  return new Map(res.rows.map(row => [row.id, row.full_name ?? '']));
};

const loadAttachments = async (exec: DbExecutor, ids: number[]): Promise<Map<number, IHrCorrectionAttachment>> => {
  if (ids.length === 0) return new Map();
  const res = await exec.query<IHrCorrectionAttachment>(
    `SELECT id, file_name, mime_type, file_size FROM documents
      WHERE id = ANY($1::bigint[]) AND deleted_at IS NULL`,
    [ids],
  );
  return new Map(res.rows.map(row => [Number(row.id), { ...row, id: Number(row.id) }]));
};

const nextIsoDay = (iso: string): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

/** Снятые дни → серии: подряд идущие дни сотрудника одного типа и одного состояния отметки. */
const groupRemoved = (rows: IDayHrState[]): IDayHrState[][] => {
  const sorted = [...rows].sort((a, b) =>
    (a.employee_id - b.employee_id)
    || a.leave_status.localeCompare(b.leave_status)
    || Number(!!a.removed_seen_at) - Number(!!b.removed_seen_at)
    || a.work_date.localeCompare(b.work_date));
  const groups: IDayHrState[][] = [];
  for (const row of sorted) {
    const last = groups[groups.length - 1];
    const tail = last?.[last.length - 1];
    if (tail
      && tail.employee_id === row.employee_id
      && tail.leave_status === row.leave_status
      && !!tail.removed_seen_at === !!row.removed_seen_at
      && nextIsoDay(tail.work_date) === row.work_date) {
      last!.push(row);
    } else {
      groups.push([row]);
    }
  }
  return groups;
};

const maxIso = (values: Array<string | null>): string | null =>
  values.filter((v): v is string => !!v).map(v => new Date(v).toISOString()).sort().pop() ?? null;

export async function listHrCorrectionItems(exec: DbExecutor): Promise<HrCorrectionItem[]> {
  const cards = groupVisibleDays(await loadVisibleDays(exec));
  const states = await loadDayStates(exec, cards.flatMap(card => card.adjustment_ids));
  const removedRes = await exec.query<IDayHrState>(
    `SELECT * FROM timesheet_correction_leave_days
      WHERE removed_at IS NOT NULL
        AND (removed_seen_at IS NULL OR removed_seen_at >= now() - make_interval(days => $1::int))`,
    [SEEN_REMOVED_KEEP_DAYS],
  );
  const removedRows = removedRes.rows.map(normalizeDayState);
  const rejectedRes = await exec.query<{
    id: number; employee_id: number; leave_status: CorrectionLeaveStatus; start_date: string; end_date: string;
    days: string[]; reason: string | null; author_id: string | null; rejected_by: string | null;
    rejected_at: string; reject_reason: string;
  }>(
    `SELECT id, employee_id, leave_status, start_date, end_date, days, reason, author_id, rejected_by,
            rejected_at, reject_reason
       FROM timesheet_correction_leave_rejections
      WHERE end_date >= $1::date
      ORDER BY rejected_at DESC`,
    [CORRECTION_LEAVE_CUTOFF],
  );

  const employees = await loadEmployees(exec, [...new Set([
    ...cards.map(c => c.employee_id),
    ...removedRows.map(r => r.employee_id),
    ...rejectedRes.rows.map(r => Number(r.employee_id)),
  ])]);
  const names = await loadProfileNames(exec, [
    ...cards.map(c => c.author_id),
    ...[...states.values()].map(s => s.acked_by),
    ...removedRows.flatMap(r => [r.author_id, r.removed_seen_by]),
    ...rejectedRes.rows.flatMap(r => [r.author_id, r.rejected_by]),
  ]);
  const attachments = await loadAttachments(exec, [...new Set(cards.flatMap(c => c.file_ids))]);
  const nameOf = (id: string | null): string | null => (id ? names.get(id) ?? null : null);
  const employeeFields = (employeeId: number) => {
    const info = employees.get(employeeId);
    return {
      employee_id: employeeId,
      employee_name: info?.full_name ?? null,
      department_name: info?.department_name ?? null,
      position_name: info?.position_name ?? null,
    };
  };

  const items: HrCorrectionItem[] = [];
  for (const card of cards) {
    const dayStates = card.dayList.map(day => states.get(day.adjustment_id));
    const acked = card.dayList.every((day, i) => isDayAcked(day, dayStates[i]));
    const lastAck = acked
      ? [...dayStates].sort((a, b) => String(b?.acked_at ?? '').localeCompare(String(a?.acked_at ?? '')))[0]
      : undefined;
    items.push({
      kind: 'correction',
      key: `tc:${card.key}`,
      ...employeeFields(card.employee_id),
      leave_status: card.status,
      start_date: card.start_date,
      end_date: card.end_date,
      days: card.days,
      adjustment_ids: card.adjustment_ids,
      version: card.version,
      reason: card.reason,
      author_name: nameOf(card.author_id),
      last_changed_at: card.last_changed_at,
      attachments: card.file_ids.map(id => attachments.get(id)).filter((a): a is IHrCorrectionAttachment => !!a),
      hr_acknowledged_at: acked ? maxIso(dayStates.map(s => s?.acked_at ?? null)) : null,
      hr_acknowledged_by_name: lastAck ? nameOf(lastAck.acked_by) : null,
    });
  }

  for (const group of groupRemoved(removedRows)) {
    const first = group[0]!;
    const kinds = new Set(group.map(r => r.removed_kind));
    const seen = group.find(r => r.removed_seen_at);
    const removedAt = maxIso(group.map(r => r.removed_at))!;
    items.push({
      kind: 'removed',
      key: `rm:${first.employee_id}:${first.leave_status}:${first.work_date}:${seen ? 's' : 'u'}`,
      ...employeeFields(first.employee_id),
      leave_status: first.leave_status,
      start_date: first.work_date,
      end_date: group[group.length - 1]!.work_date,
      days: group.map(r => r.work_date),
      adjustment_ids: group.map(r => r.adjustment_id),
      removed_kind: kinds.size > 1 ? 'mixed' : (first.removed_kind ?? 'deleted'),
      removed_at: removedAt,
      author_name: nameOf(first.author_id),
      last_changed_at: removedAt,
      hr_acknowledged_at: seen ? maxIso(group.map(r => r.removed_seen_at)) : null,
      hr_acknowledged_by_name: seen ? nameOf(seen.removed_seen_by) : null,
    });
  }

  for (const row of rejectedRes.rows) {
    const rejectedAt = new Date(row.rejected_at).toISOString();
    items.push({
      kind: 'rejected',
      key: `rj:${row.id}`,
      id: Number(row.id),
      ...employeeFields(Number(row.employee_id)),
      leave_status: row.leave_status,
      start_date: row.start_date,
      end_date: row.end_date,
      days: row.days,
      reason: row.reason,
      author_name: nameOf(row.author_id),
      rejected_at: rejectedAt,
      rejected_by_name: nameOf(row.rejected_by),
      reject_reason: row.reject_reason,
      last_changed_at: rejectedAt,
      // Отказ — тоже решение кадров: карточка уходит в «Ознакомлен».
      hr_acknowledged_at: rejectedAt,
      hr_acknowledged_by_name: nameOf(row.rejected_by),
    });
  }

  return items.sort((a, b) => b.last_changed_at.localeCompare(a.last_changed_at));
}
