// Отпуск, поставленный корректировкой табеля, — во вкладке кадров «Заявления → Отпуска»
// (миграция 311).
//
// Карточка НЕ хранится, а вычисляется из табеля: серия ручных отпускных дней подряд с одним
// сотрудником, типом, автором и причиной. Так карточка всегда совпадает с табелем, какой бы
// путь записи её ни изменил (день, массовая правка, объектный режим, удаление, заявление).
// loadVisibleDays — единственный источник: по нему строятся список, уведомления (сверщик),
// проверки «Ознакомлен» / «Отказать» и доступ к файлам.

import { createHash } from 'node:crypto';
import { getPool, type DbExecutor } from '../config/postgres.js';
import { getRolePageAccess } from './access-control.service.js';

export const CORRECTION_LEAVE_STATUSES = ['vacation', 'unpaid', 'educational_leave'] as const;
export type CorrectionLeaveStatus = typeof CORRECTION_LEAVE_STATUSES[number];

/** Запуск функции: раньше кадры закрыли месяцы сами, старые серии во вкладку не тянем. */
export const CORRECTION_LEAVE_CUTOFF = '2026-10-01';
/** Серия, пересекающая cutoff, показывается целиком — строки берём с запасом. */
const SERIES_LOOKBACK_DAYS = 120;

/** Общий advisory-лок кадровых решений и сверщика (одноключевая форма hashtext). */
export const CORRECTION_LEAVE_LOCK_KEY = 'correction_leave:hr';
export const HR_VACATIONS_PAGE = '/leave-vacations';
export const HR_VACATIONS_PATH = '/leave-requests?tab=vacations';

const CORRECTION_ATTACHMENT_ENTITY = 'attendance_adjustment';
const CORRECTION_ATTACHMENT_PURPOSE = 'timesheet_correction';

export const isCorrectionLeaveStatus = (status: unknown): status is CorrectionLeaveStatus =>
  typeof status === 'string' && (CORRECTION_LEAVE_STATUSES as readonly string[]).includes(status);

export interface IVisibleLeaveDay {
  adjustment_id: number;
  employee_id: number;
  work_date: string;
  status: CorrectionLeaveStatus;
  author_id: string | null;
  reason: string | null;
  files_sig: string;
  series_start: string;
  updated_at: string;
}

const VISIBLE_DAYS_SQL = `
  WITH base AS (
    SELECT a.id, a.employee_id, a.work_date, a.status, a.created_by, a.reason, a.updated_at,
           lower(btrim(coalesce(a.reason, ''))) AS reason_key
      FROM attendance_adjustments a
     WHERE a.source_type = 'manual'
       AND a.status = ANY($1::text[])
       AND a.work_date >= $2::date - $3::int
       AND ($4::int IS NULL OR a.employee_id = $4::int)
       -- Как вкладка «Отпуска»: рабочих (системная роль worker) не показываем.
       AND NOT EXISTS (
             SELECT 1 FROM user_profiles up
               JOIN system_roles sr ON sr.id = up.system_role_id
              WHERE up.employee_id = a.employee_id AND sr.code = 'worker')
       -- День уже покрыт заявлением того же типа — кадры видят само заявление.
       AND NOT EXISTS (
             SELECT 1 FROM leave_requests lr
              WHERE lr.employee_id = a.employee_id
                AND lr.request_type = a.status
                AND lr.status IN ('approved', 'pending')
                AND a.work_date BETWEEN lr.start_date AND lr.end_date
                AND (coalesce(cardinality(lr.selected_dates), 0) = 0 OR a.work_date = ANY(lr.selected_dates)))
  ), grouped AS (
    SELECT b.*,
           b.work_date - (row_number() OVER (
             PARTITION BY b.employee_id, b.status, b.created_by, b.reason_key ORDER BY b.work_date))::int AS grp
      FROM base b
  ), series AS (
    SELECT g.*,
           min(g.work_date) OVER w AS series_start,
           max(g.work_date) OVER w AS series_end
      FROM grouped g
    WINDOW w AS (PARTITION BY g.employee_id, g.status, g.created_by, g.reason_key, g.grp)
  )
  SELECT s.id AS adjustment_id,
         s.employee_id,
         s.work_date,
         s.status,
         s.created_by AS author_id,
         s.reason,
         s.series_start,
         s.updated_at,
         coalesce((
           SELECT string_agg(dl.document_id::text, ',' ORDER BY dl.document_id)
             FROM document_links dl
            WHERE dl.entity_type = '${CORRECTION_ATTACHMENT_ENTITY}'
              AND dl.purpose = '${CORRECTION_ATTACHMENT_PURPOSE}'
              AND dl.entity_id = s.id::text), '') AS files_sig
    FROM series s
   WHERE s.series_end >= $2::date
   ORDER BY s.employee_id, s.series_start, s.work_date`;

/** Видимые во вкладке дни (опционально — одного сотрудника). */
export async function loadVisibleDays(
  exec: DbExecutor,
  opts: { employeeId?: number } = {},
): Promise<IVisibleLeaveDay[]> {
  const res = await exec.query<IVisibleLeaveDay>(VISIBLE_DAYS_SQL, [
    [...CORRECTION_LEAVE_STATUSES],
    CORRECTION_LEAVE_CUTOFF,
    SERIES_LOOKBACK_DAYS,
    opts.employeeId ?? null,
  ]);
  return res.rows.map(row => ({
    ...row,
    adjustment_id: Number(row.adjustment_id),
    employee_id: Number(row.employee_id),
    updated_at: new Date(row.updated_at).toISOString(),
  }));
}

export interface ICorrectionLeaveCardCore {
  key: string;
  employee_id: number;
  status: CorrectionLeaveStatus;
  author_id: string | null;
  reason: string | null;
  start_date: string;
  end_date: string;
  days: string[];
  adjustment_ids: number[];
  file_ids: number[];
  version: string;
  last_changed_at: string;
  dayList: IVisibleLeaveDay[];
}

/**
 * Версия карточки для «Ознакомлен» / «Отказать»: состав дней + тип + файлы каждого дня.
 * updated_at сюда не входит: пересохранение того же отпуска версию не меняет.
 */
export const cardVersion = (days: readonly IVisibleLeaveDay[]): string => createHash('sha1')
  .update([...days]
    .sort((a, b) => a.adjustment_id - b.adjustment_id)
    .map(d => `${d.adjustment_id}:${d.status}:${d.files_sig}`)
    .join('|'))
  .digest('hex');

export const parseFilesSig = (sig: string): number[] =>
  sig ? sig.split(',').map(Number).filter(Number.isFinite) : [];

/** Дни → карточки. У сотрудника на дату одна ручная строка, поэтому (сотрудник, начало) уникален. */
export function groupVisibleDays(days: readonly IVisibleLeaveDay[]): ICorrectionLeaveCardCore[] {
  const byKey = new Map<string, IVisibleLeaveDay[]>();
  for (const day of days) {
    const key = `${day.employee_id}:${day.series_start}`;
    const list = byKey.get(key) ?? [];
    list.push(day);
    byKey.set(key, list);
  }
  return [...byKey.entries()].map(([key, list]) => {
    const sorted = [...list].sort((a, b) => a.work_date.localeCompare(b.work_date));
    const first = sorted[0]!;
    const fileIds = [...new Set(sorted.flatMap(d => parseFilesSig(d.files_sig)))].sort((a, b) => a - b);
    return {
      key,
      employee_id: first.employee_id,
      status: first.status,
      author_id: first.author_id,
      reason: first.reason,
      start_date: first.work_date,
      end_date: sorted[sorted.length - 1]!.work_date,
      days: sorted.map(d => d.work_date),
      adjustment_ids: sorted.map(d => d.adjustment_id),
      file_ids: fileIds,
      version: cardVersion(sorted),
      last_changed_at: sorted.map(d => d.updated_at).sort().pop()!,
      dayList: sorted,
    };
  });
}

/** Карточка, в которой лежит день (по свежему табелю сотрудника). */
export async function findCardByAdjustmentId(
  exec: DbExecutor,
  adjustmentId: number,
): Promise<ICorrectionLeaveCardCore | null> {
  const owner = await exec.query<{ employee_id: number }>(
    'SELECT employee_id FROM attendance_adjustments WHERE id = $1',
    [adjustmentId],
  );
  const employeeId = owner.rows[0]?.employee_id;
  if (employeeId == null) return null;
  const cards = groupVisibleDays(await loadVisibleDays(exec, { employeeId: Number(employeeId) }));
  return cards.find(card => card.adjustment_ids.includes(adjustmentId)) ?? null;
}

export interface IDayHrState {
  adjustment_id: number;
  employee_id: number;
  work_date: string;
  leave_status: CorrectionLeaveStatus;
  files_sig: string;
  author_id: string | null;
  notified_at: string | null;
  acked_at: string | null;
  acked_by: string | null;
  acked_status: string | null;
  acked_files_sig: string | null;
  removed_at: string | null;
  removed_kind: 'deleted' | 'status_changed' | null;
  removed_seen_at: string | null;
  removed_seen_by: string | null;
}

/** День ознакомлен, только если отметка снята с той же версии дня (тип + файлы). */
export const isDayAcked = (day: IVisibleLeaveDay, state: IDayHrState | undefined): boolean =>
  !!state?.acked_at && state.acked_status === day.status && state.acked_files_sig === day.files_sig;

const isoOrNull = (value: unknown): string | null =>
  value == null ? null : new Date(value as string | Date).toISOString();

/** Строка состояния из pg: timestamptz приходят Date — приводим к ISO, id — к числу. */
export const normalizeDayState = (row: IDayHrState): IDayHrState => ({
  ...row,
  adjustment_id: Number(row.adjustment_id),
  employee_id: Number(row.employee_id),
  notified_at: isoOrNull(row.notified_at),
  acked_at: isoOrNull(row.acked_at),
  removed_at: isoOrNull(row.removed_at),
  removed_seen_at: isoOrNull(row.removed_seen_at),
});

export async function loadDayStates(exec: DbExecutor, adjustmentIds: number[]): Promise<Map<number, IDayHrState>> {
  if (adjustmentIds.length === 0) return new Map();
  const res = await exec.query<IDayHrState>(
    'SELECT * FROM timesheet_correction_leave_days WHERE adjustment_id = ANY($1::bigint[])',
    [adjustmentIds],
  );
  return new Map(res.rows.map(row => [Number(row.adjustment_id), normalizeDayState(row)]));
}

/**
 * Кадры — адресаты уведомлений: одобренные учётки, у роли которых есть просмотр вкладки
 * «Отпуска». Область — вся организация, как у самой вкладки (скоуп отделов не применяется).
 */
export async function listHrRecipientIds(exec: DbExecutor = getPool()): Promise<string[]> {
  const profiles = await exec.query<{ id: string; system_role_id: string }>(
    'SELECT id, system_role_id FROM user_profiles WHERE is_approved = true AND system_role_id IS NOT NULL',
  );
  const roleIds = [...new Set(profiles.rows.map(p => p.system_role_id))];
  const allowed = new Set<string>();
  await Promise.all(roleIds.map(async (roleId) => {
    const access = (await getRolePageAccess(roleId))[HR_VACATIONS_PAGE];
    if (access?.can_view || access?.can_edit) allowed.add(roleId);
  }));
  return profiles.rows.filter(p => allowed.has(p.system_role_id)).map(p => p.id);
}

/**
 * Файл корректировки для вкладки «Отпуска»: отдаём, только если документ привязан к дню,
 * который сейчас виден во вкладке. Право — то же, что у списка (/leave-vacations).
 */
export async function findVisibleCorrectionDocument(
  exec: DbExecutor,
  documentId: number,
): Promise<{ r2_key: string; file_name: string } | null> {
  const links = await exec.query<{ adjustment_id: string; employee_id: number; r2_key: string; file_name: string }>(
    `SELECT dl.entity_id AS adjustment_id, a.employee_id, d.r2_key, d.file_name
       FROM document_links dl
       JOIN documents d ON d.id = dl.document_id AND d.deleted_at IS NULL
       JOIN attendance_adjustments a ON a.id::text = dl.entity_id
      WHERE dl.document_id = $1
        AND dl.entity_type = $2
        AND dl.purpose = $3`,
    [documentId, CORRECTION_ATTACHMENT_ENTITY, CORRECTION_ATTACHMENT_PURPOSE],
  );
  if (links.rows.length === 0) return null;
  const linkedIds = new Set(links.rows.map(row => Number(row.adjustment_id)));
  for (const employeeId of new Set(links.rows.map(row => Number(row.employee_id)))) {
    const visible = await loadVisibleDays(exec, { employeeId });
    if (visible.some(day => linkedIds.has(day.adjustment_id))) {
      return { r2_key: links.rows[0]!.r2_key, file_name: links.rows[0]!.file_name };
    }
  }
  return null;
}
