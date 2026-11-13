/**
 * Проверка после прогона «табель ФОТ = табель 1С (ЗУП)» — только чтение.
 *
 * - Закрытые подачи: метка пересборки снята, ошибки пересборки нет, редакция есть (новой может не быть, если
 *   состав табеля подачи не изменился).
 * - Основа зарплаты: у сотрудника, который входит в редакцию закрытой подачи, «Расчёты» берут основу, и день в ней
 *   такой, как в 1С. Не входит (уволенный в месяце увольнения) — «Расчёты» по живому табелю, проверен отдельно.
 * - Живой табель: каждый день прогона ФОТ отдаёт как в 1С (часы к оплате, отметка, пустой день).
 */
import type { PoolClient } from 'pg';
import { loadMonthBasisSources, type IMonthBasisSource } from './payroll/payroll-month-basis.service.js';
import type { IZupApplyDeps } from './timesheet-zup-align.apply.js';
import { zupPairKey, type IZupDaySnapshot } from './timesheet-zup-align.snapshot.js';
import type { IZupBackup, ZupTarget } from './timesheet-zup-align.types.js';

export interface IZupVerifyIssue {
  employee_id?: number;
  date?: string;
  approval_id?: number;
  issue: string;
}

const targetOf = (row: Record<string, unknown>): ZupTarget => {
  const status = String(row.status);
  const hours = row.hours_override == null ? null : Number(row.hours_override);
  if (status === 'manual') return hours && hours > 0 ? { kind: 'day', hours } : { kind: 'zero' };
  if (status === 'remote' && hours && hours > 0) return { kind: 'status', status: 'remote', hours };
  return { kind: 'status', status: status as 'unpaid' | 'remote' | 'vacation' | 'sick' };
};

/** День живого табеля совпадает с целью. */
export const liveDayMatches = (snapshot: IZupDaySnapshot | undefined, target: ZupTarget): string | null => {
  if (!snapshot) return 'нет снимка дня';
  const worked = snapshot.kind === 'workday' || snapshot.kind === 'dayoff';
  switch (target.kind) {
    case 'object':
    case 'day':
      if (!worked) return `день не рабочий в основе (${snapshot.kind ?? 'пусто'})`;
      return snapshot.paidMinutes === target.hours * 60 ? null : `к оплате ${(snapshot.paidMinutes ?? 0) / 60} ч, в 1С ${target.hours} ч`;
    case 'zero':
      return snapshot.kind == null ? null : `день не пустой (${snapshot.kind})`;
    case 'status':
      if (target.status === 'remote') {
        if (snapshot.status !== 'remote' || !worked) return `ожидалась удалёнка рабочим днём, ${snapshot.status ?? 'пусто'} (${snapshot.kind ?? 'не в основе'})`;
        if (target.hours && snapshot.paidMinutes !== target.hours * 60) return `удалёнка: к оплате ${(snapshot.paidMinutes ?? 0) / 60} ч, в 1С ${target.hours} ч`;
        return null;
      }
      return snapshot.kind === 'absence' && snapshot.absence === target.status ? null : `ожидалось ${target.status}, ${snapshot.absence ?? snapshot.kind ?? 'пусто'}`;
  }
};

/** День закрытой основы совпадает с целью. */
const basisDayMatches = (source: IMonthBasisSource, date: string, target: ZupTarget): string | null => {
  const worked = source.workdayDates.includes(date) || source.dayoffDates.includes(date);
  const absence = Object.entries(source.absenceDates ?? {}).find(([, dates]) => (dates ?? []).includes(date))?.[0] ?? null;
  switch (target.kind) {
    case 'object':
    case 'day':
      if (!worked) return 'в основе день не рабочий';
      if (source.paidMinutes && source.paidMinutes[date] !== target.hours * 60) return `в основе ${(source.paidMinutes[date] ?? 0) / 60} ч`;
      return null;
    case 'zero':
      return worked || absence ? 'в основе день не пустой' : null;
    case 'status':
      if (target.status === 'remote') {
        if (!worked) return 'в основе удалёнка не рабочий день';
        if (target.hours && source.paidMinutes && source.paidMinutes[date] !== target.hours * 60) {
          return `в основе удалёнка ${(source.paidMinutes[date] ?? 0) / 60} ч`;
        }
        return null;
      }
      return absence === target.status ? null : `в основе ${absence ?? 'нет отсутствия'}`;
  }
};

export const verifyZupRun = async (
  client: PoolClient,
  backup: IZupBackup,
  deps: IZupApplyDeps,
): Promise<IZupVerifyIssue[]> => {
  const issues: IZupVerifyIssue[] = [];

  if (backup.approval_ids.length > 0) {
    const approvals = await client.query<{
      id: string; status: string; unlocked_at: string | null; version_dirty_at: string | null;
      version_rebuild_last_error: string | null; version_id: string | null; version_created_at: string | null;
    }>(
      `SELECT a.id::text, a.status, a.unlocked_at::text, a.version_dirty_at::text, a.version_rebuild_last_error,
              v.id::text AS version_id, v.created_at::text AS version_created_at
         FROM timesheet_approvals a
         LEFT JOIN LATERAL (
           SELECT id, created_at FROM timesheet_versions WHERE approval_id = a.id ORDER BY revision DESC LIMIT 1
         ) v ON TRUE
        WHERE a.id = ANY($1::bigint[])`,
      [backup.approval_ids],
    );
    for (const a of approvals.rows) {
      const approvalId = Number(a.id);
      if (a.status !== 'approved' || a.unlocked_at) issues.push({ approval_id: approvalId, issue: 'подачу открыли или вернули' });
      if (a.version_dirty_at) issues.push({ approval_id: approvalId, issue: 'пересборка ещё не прошла' });
      if (a.version_rebuild_last_error) issues.push({ approval_id: approvalId, issue: `ошибка пересборки: ${a.version_rebuild_last_error}` });
      // Новой редакции может и не быть: пересборка не пишет её, если состав табеля подачи тот же. Дни такой
      // подачи проверяются ниже по основе зарплаты.
      if (!a.version_id) issues.push({ approval_id: approvalId, issue: 'у подачи нет редакции' });
    }
  }

  const employeeIds = [...new Set(backup.days.map(day => day.employee_id))];
  const sources = await loadMonthBasisSources(employeeIds, backup.month);
  // Кто входит в последнюю редакцию закрытых подач: уволенных в месяце увольнения в редакцию не включают, хотя
  // в составе подачи они числятся, — их «Расчёты» идут по живому табелю, закрытой основы у них нет.
  const inVersion = new Set((await client.query<{ approval_id: string; employee_id: number }>(
    `SELECT DISTINCT v.approval_id::text, b.employee_id
       FROM (SELECT DISTINCT ON (approval_id) id, approval_id FROM timesheet_versions
              WHERE approval_id = ANY($1::bigint[]) ORDER BY approval_id, revision DESC) v
       JOIN timesheet_version_payroll_basis b ON b.version_id = v.id
      WHERE b.employee_id = ANY($2::int[]) AND b.month = $3::date`,
    [backup.approval_ids, employeeIds, `${backup.month}-01`],
  )).rows.map(row => `${row.approval_id}|${row.employee_id}`));
  const snapshots = await deps.loadSnapshots(
    client, backup.month, backup.days.map(day => ({ employeeId: day.employee_id, date: day.date })),
  );

  for (const day of backup.days) {
    const metadata = (day.zup_row.metadata ?? {}) as Record<string, unknown>;
    const base = targetOf(day.zup_row);
    const target: ZupTarget = metadata.object_name != null && base.kind === 'day'
      ? { kind: 'object', hours: base.hours, object: { key: String(day.zup_row.source_id), id: (metadata.object_id as string | null) ?? null, name: String(metadata.object_name) } }
      : base;

    const live = liveDayMatches(snapshots.get(zupPairKey(day.employee_id, day.date)), target);
    if (live) issues.push({ employee_id: day.employee_id, date: day.date, issue: `живой табель: ${live}` });

    const snapshot = snapshots.get(zupPairKey(day.employee_id, day.date));
    if (!snapshot || snapshot.closedApprovalIds.length === 0) continue;
    if (!snapshot.closedApprovalIds.some(id => inVersion.has(`${id}|${day.employee_id}`))) continue;
    const covering = (sources.get(day.employee_id) ?? []).filter(s => s.coverFrom <= day.date && day.date <= s.coverTo);
    if (covering.length === 0) {
      issues.push({ employee_id: day.employee_id, date: day.date, issue: 'закрытой основы на день нет' });
      continue;
    }
    for (const source of covering) {
      const problem = basisDayMatches(source, day.date, target);
      if (problem) issues.push({ employee_id: day.employee_id, date: day.date, issue: `основа ${source.versionId}: ${problem}` });
    }
  }
  return issues;
};
