/**
 * One-off backfill for pending "work on weekend/holiday" leave requests that
 * were created before work requests were materialized into attendance_adjustments
 * at creation time.
 *
 * Default mode is dry-run. Write mode requires --apply.
 *
 * Usage:
 *   cd fot-server
 *   npx tsx scripts/backfill-pending-work-leave-requests.ts --id=123
 *   npx tsx scripts/backfill-pending-work-leave-requests.ts --id=123 --apply
 *   npx tsx scripts/backfill-pending-work-leave-requests.ts --from=2026-06-01 --to=2026-06-30
 */
import { closeDb, query, withTransaction } from '../src/config/postgres.js';
import { upsertAttendanceAdjustment } from '../src/services/attendance.service.js';
import { resolveAdjustmentApprovalStatus } from '../src/controllers/timesheet.controller.js';
import type { TimeStatus } from '../src/types/index.js';

interface IWorkLeaveRequestRow {
  id: number;
  employee_id: number;
  employee_name: string | null;
  department_name: string | null;
  reason: string | null;
  start_date: string;
  end_date: string;
  selected_dates: string[] | null;
  author_user_id: string | null;
  reviewer_id: string | null;
}

interface IExistingAdjustmentRow {
  work_date: string;
  approval_status: 'auto_approved' | 'pending' | 'approved' | 'rejected';
}

interface IOptions {
  apply: boolean;
  id: number | null;
  from: string | null;
  to: string | null;
  limit: number | null;
}

const WORK_STATUS: TimeStatus = 'work';

function getArgValue(name: string): string | null {
  const prefix = `--${name}=`;
  const arg = process.argv.find(item => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

function parsePositiveInt(raw: string | null, label: string): number | null {
  if (!raw) return null;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${label} must be a positive integer`);
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function parseDate(raw: string | null, label: string): string | null {
  if (!raw) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new Error(`${label} must be YYYY-MM-DD`);
  }
  return raw;
}

function parseOptions(): IOptions {
  if (process.argv.includes('--help')) {
    console.log([
      'Usage:',
      '  npx tsx scripts/backfill-pending-work-leave-requests.ts [--id=ID] [--from=YYYY-MM-DD] [--to=YYYY-MM-DD] [--limit=N] [--apply]',
      '',
      'Default mode is dry-run. Add --apply to write attendance_adjustments and approve auto-approved requests.',
    ].join('\n'));
    process.exit(0);
  }

  return {
    apply: process.argv.includes('--apply'),
    id: parsePositiveInt(getArgValue('id'), '--id'),
    from: parseDate(getArgValue('from'), '--from'),
    to: parseDate(getArgValue('to'), '--to'),
    limit: parsePositiveInt(getArgValue('limit'), '--limit'),
  };
}

function normalizeIsoDate(raw: unknown): string | null {
  if (typeof raw === 'string') {
    const iso = raw.slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : null;
  }
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    return raw.toISOString().slice(0, 10);
  }
  return null;
}

function collectWorkDates(row: IWorkLeaveRequestRow): string[] {
  const dates: string[] = [];
  if (Array.isArray(row.selected_dates) && row.selected_dates.length > 0) {
    for (const raw of row.selected_dates) {
      const iso = normalizeIsoDate(raw);
      if (iso) dates.push(iso);
    }
  } else {
    const start = new Date(`${row.start_date.slice(0, 10)}T00:00:00Z`);
    const end = new Date(`${row.end_date.slice(0, 10)}T00:00:00Z`);
    for (const cursor = new Date(start); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
      dates.push(cursor.toISOString().slice(0, 10));
    }
  }
  return [...new Set(dates)].sort();
}

async function loadCandidateRequests(options: IOptions): Promise<IWorkLeaveRequestRow[]> {
  const params: unknown[] = [];
  const addParam = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  const where = [
    `lr.status = 'pending'`,
    `lr.request_type = 'work'`,
  ];

  if (options.id) {
    where.push(`lr.id = ${addParam(options.id)}::bigint`);
  }
  if (options.from) {
    where.push(`lr.end_date >= ${addParam(options.from)}::date`);
  }
  if (options.to) {
    where.push(`lr.start_date <= ${addParam(options.to)}::date`);
  }

  const limitSql = options.limit ? `LIMIT ${addParam(options.limit)}::int` : '';

  return query<IWorkLeaveRequestRow>(
    `SELECT lr.id,
            lr.employee_id,
            e.full_name AS employee_name,
            od.name AS department_name,
            lr.reason,
            lr.start_date::text AS start_date,
            lr.end_date::text AS end_date,
            ARRAY(SELECT d::text FROM unnest(lr.selected_dates) d ORDER BY d) AS selected_dates,
            author.id AS author_user_id,
            lr.reviewer_id
       FROM leave_requests lr
       JOIN employees e ON e.id = lr.employee_id
       LEFT JOIN org_departments od ON od.id = e.org_department_id
       LEFT JOIN user_profiles author ON author.employee_id = lr.employee_id
      WHERE ${where.join(' AND ')}
      ORDER BY lr.id ASC
      ${limitSql}`,
    params,
  );
}

async function loadExistingAdjustments(requestId: number): Promise<IExistingAdjustmentRow[]> {
  return query<IExistingAdjustmentRow>(
    `SELECT work_date::text AS work_date, approval_status
       FROM attendance_adjustments
      WHERE source_type = 'leave_request'
        AND source_id = $1
      ORDER BY work_date ASC`,
    [String(requestId)],
  );
}

async function buildPlan(row: IWorkLeaveRequestRow): Promise<{
  dates: string[];
  existing: IExistingAdjustmentRow[];
  missingDates: string[];
  approvalsByDate: Map<string, 'auto_approved' | 'pending'>;
  finalLeaveStatus: 'pending' | 'approved';
}> {
  const dates = collectWorkDates(row);
  const existing = await loadExistingAdjustments(row.id);
  const existingDates = new Set(existing.map(item => item.work_date.slice(0, 10)));
  const missingDates = dates.filter(date => !existingDates.has(date));
  const approvalsByDate = new Map<string, 'auto_approved' | 'pending'>();

  for (const date of missingDates) {
    approvalsByDate.set(
      date,
      await resolveAdjustmentApprovalStatus(row.employee_id, date, WORK_STATUS, null),
    );
  }

  const allStatuses = [
    ...existing.map(item => item.approval_status),
    ...approvalsByDate.values(),
  ];
  const finalLeaveStatus = allStatuses.length > 0 && !allStatuses.includes('pending') && !allStatuses.includes('rejected')
    ? 'approved'
    : 'pending';

  return { dates, existing, missingDates, approvalsByDate, finalLeaveStatus };
}

async function applyPlan(
  row: IWorkLeaveRequestRow,
  plan: Awaited<ReturnType<typeof buildPlan>>,
): Promise<number> {
  if (plan.missingDates.length === 0) return 0;
  const createdBy = row.author_user_id ?? row.reviewer_id ?? null;

  return withTransaction(async (client) => {
    let written = 0;
    for (const date of plan.missingDates) {
      const approvalStatus = plan.approvalsByDate.get(date) ?? 'auto_approved';
      await upsertAttendanceAdjustment({
        employee_id: row.employee_id,
        work_date: date,
        status: WORK_STATUS,
        hours_override: null,
        source_type: 'leave_request',
        source_id: String(row.id),
        reason: row.reason ?? null,
        created_by: createdBy,
        approval_status: approvalStatus,
      }, client);
      written += 1;
    }

    if (plan.finalLeaveStatus === 'approved') {
      await client.query(
        `UPDATE leave_requests
            SET status = 'approved',
                reviewer_id = COALESCE($2::uuid, reviewer_id),
                reviewed_at = NOW(),
                updated_at = NOW()
          WHERE id = $1
            AND status = 'pending'`,
        [row.id, createdBy],
      );
    }

    return written;
  });
}

async function main(): Promise<void> {
  const options = parseOptions();
  const rows = await loadCandidateRequests(options);
  console.log(`[backfill-pending-work] mode=${options.apply ? 'APPLY' : 'DRY-RUN'} candidates=${rows.length}`);

  let changedRequests = 0;
  let writtenAdjustments = 0;
  let alreadyMaterialized = 0;
  let wouldApprove = 0;

  for (const row of rows) {
    const plan = await buildPlan(row);
    if (plan.missingDates.length === 0) {
      alreadyMaterialized += 1;
      continue;
    }

    changedRequests += 1;
    const pendingCount = [...plan.approvalsByDate.values()].filter(status => status === 'pending').length;
    const autoCount = plan.approvalsByDate.size - pendingCount;
    if (plan.finalLeaveStatus === 'approved') wouldApprove += 1;

    console.log(
      `[${options.apply ? 'apply' : 'dry'}] request=${row.id} employee=${row.employee_id}`
      + ` dates=${plan.missingDates.join(',')}`
      + ` pending=${pendingCount} auto=${autoCount}`
      + ` leave_status_after=${plan.finalLeaveStatus}`
      + (row.employee_name ? ` name="${row.employee_name}"` : '')
      + (row.department_name ? ` dept="${row.department_name}"` : ''),
    );

    if (options.apply) {
      writtenAdjustments += await applyPlan(row, plan);
    } else {
      writtenAdjustments += plan.missingDates.length;
    }
  }

  console.log('[backfill-pending-work] result:');
  console.log(`  requests_with_missing_adjustments=${changedRequests}`);
  console.log(`  ${options.apply ? 'written_adjustments' : 'would_write_adjustments'}=${writtenAdjustments}`);
  console.log(`  ${options.apply ? 'approved_leave_requests' : 'would_approve_leave_requests'}=${wouldApprove}`);
  console.log(`  already_materialized=${alreadyMaterialized}`);
  if (!options.apply && changedRequests > 0) {
    console.log('  dry-run only; rerun with --apply to write changes');
  }
}

main()
  .catch((err) => {
    console.error('[backfill-pending-work] fatal:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
