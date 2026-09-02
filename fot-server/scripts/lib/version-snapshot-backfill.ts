/**
 * Общий обход для бэкфилла снимков, привязанных к редакции табеля.
 *
 * Снимки (объектная разбивка — миграция 263, руководители — 264) создаются вместе с
 * версией. У редакций, закрытых ДО внедрения, их нет, и публичные методы отвечают по ним
 * отказом. Скрипты-бэкфиллы дописывают недостающее.
 *
 * Обход у них одинаковый, различается только «что именно собрать и куда записать»,
 * поэтому логика выборки кандидатов, транзакции, правила ACK и отчёта живёт здесь —
 * иначе вторая копия неизбежно разъедется с первой.
 *
 * ПРАВИЛО ACK — главное. Состояние выгрузки считается сравнением ack.version_id с
 * текущим version_id, поэтому:
 *   - редакция НЕ подтверждена — снимок дописывается на месте, revision не растёт;
 *   - редакция УЖЕ подтверждена — дописать нельзя: подача осталась бы exported, 1С о
 *     новых данных не узнала бы, а старый ACK выглядел бы подтверждением того, чего на
 *     момент ACK не существовало. По умолчанию такие пропускаются; с --notify-acked
 *     создаётся новая редакция с тем же payload и content_hash.
 */
import type { PoolClient } from 'pg';
import { query } from '../../src/config/postgres.js';
import { withTimesheetSnapshotTransaction } from '../../src/services/timesheet-snapshot-tx.js';
import {
  monthAnchorsInRange,
  type ITimesheetVersionPayload,
  type IVersionApproval,
} from '../../src/services/timesheet-version.service.js';

/** Та же глубина, что ограничивает список публичного API. */
export const MAX_EXPORT_DEPTH_MONTHS = 3;

export interface IBackfillOptions {
  dryRun: boolean;
  from: string | null;
  to: string | null;
  limit: number | null;
  notifyAcked: boolean;
}

export function parseBackfillArgs(argv: string[] = process.argv.slice(2)): IBackfillOptions {
  const get = (name: string): string | null => {
    const found = argv.find(a => a.startsWith(`--${name}=`));
    return found ? found.slice(name.length + 3) : null;
  };
  const limitRaw = get('limit');
  return {
    dryRun: argv.includes('--dry-run'),
    from: get('from'),
    to: get('to'),
    limit: limitRaw && /^\d+$/.test(limitRaw) ? Number(limitRaw) : null,
    notifyAcked: argv.includes('--notify-acked'),
  };
}

export function defaultFromDate(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - MAX_EXPORT_DEPTH_MONTHS, 1))
    .toISOString().slice(0, 10);
}

export interface ICandidateRow {
  approval_id: number | string;
  department_id: string | null;
  manager_employee_id: number | string | null;
  start_date: string;
  end_date: string;
  status: string;
  version_id: number | string;
  revision: number | string;
  content_hash: string;
  payload: ITimesheetVersionPayload;
  scope_kind: string;
  employees_count: number | string;
  total_hours: string | number;
  membership_windows: unknown;
  acked: boolean;
}

export interface IBackfillSpec {
  /** Человекочитаемое имя для вывода: «объектная разбивка», «руководители». */
  title: string;
  /** Таблица снимка — по ней ищутся редакции без него. */
  snapshotTable: string;
  /**
   * Собрать и записать снимок для указанной версии.
   * Целевые данные берутся из СОХРАНЁННОГО payload — живой расчёт не должен подменять
   * официальный табель.
   */
  write(client: PoolClient, versionId: number, approval: IVersionApproval,
        payload: ITimesheetVersionPayload): Promise<{ warnings: number }>;
}

export async function runVersionSnapshotBackfill(
  spec: IBackfillSpec,
  opts: IBackfillOptions,
): Promise<void> {
  const from = opts.from ?? defaultFromDate();
  const to = opts.to ?? '9999-12-31';

  // Только последняя редакция подачи: 1С работает с ней, старые не трогаем.
  // unlocked_at / version_dirty_at отсекаем — там содержимое ещё в движении.
  const rows = await query<ICandidateRow>(
    `SELECT a.id                AS approval_id,
            a.department_id,
            a.manager_employee_id,
            a.start_date::text  AS start_date,
            a.end_date::text    AS end_date,
            a.status,
            v.id                AS version_id,
            v.revision,
            v.content_hash,
            v.payload,
            v.scope_kind,
            v.employees_count,
            v.total_hours,
            v.membership_windows,
            (ack.version_id IS NOT NULL) AS acked
       FROM timesheet_approvals a
       JOIN LATERAL (
         SELECT tv.* FROM timesheet_versions tv
          WHERE tv.approval_id = a.id
          ORDER BY tv.revision DESC
          LIMIT 1
       ) v ON true
       LEFT JOIN timesheet_1c_exports ack ON ack.version_id = v.id
      WHERE a.status = 'approved'
        AND a.unlocked_at IS NULL
        AND a.version_dirty_at IS NULL
        AND a.start_date >= $1::date
        AND a.start_date <= $2::date
        AND NOT EXISTS (
          SELECT 1 FROM ${spec.snapshotTable} sn WHERE sn.version_id = v.id
        )
      ORDER BY a.start_date DESC, a.id DESC
      ${opts.limit ? `LIMIT ${opts.limit}` : ''}`,
    [from, to],
  );

  const ackedCount = rows.filter(row => row.acked).length;
  console.log(`${spec.title}: редакций без снимка — ${rows.length} (период ${from}..${to})`);
  console.log(`  из них уже подтверждённых 1С: ${ackedCount}`);
  if (ackedCount > 0) {
    console.log(opts.notifyAcked
      ? `  --notify-acked: у них вырастет revision — ${ackedCount} подач станут stale и будут перезабраны 1С`
      : '  будут ПРОПУЩЕНЫ (для доставки по ним нужен флаг --notify-acked)');
  }

  if (opts.dryRun) {
    for (const row of rows) {
      console.log(`  [dry-run] approval ${row.approval_id} rev ${row.revision}`
        + ` (${row.start_date}..${row.end_date})${row.acked ? ' — ACK' : ''}`);
    }
    console.log('Режим --dry-run: ничего не записано.');
    return;
  }

  let attached = 0;
  let revisioned = 0;
  let skippedAcked = 0;
  const withWarnings: Array<{ id: number; count: number }> = [];
  const failed: Array<{ id: number; error: string }> = [];

  for (const row of rows) {
    const approvalId = Number(row.approval_id);
    if (row.acked && !opts.notifyAcked) {
      skippedAcked += 1;
      continue;
    }

    const approval: IVersionApproval = {
      id: approvalId,
      department_id: row.department_id,
      manager_employee_id: row.manager_employee_id != null ? Number(row.manager_employee_id) : null,
      start_date: row.start_date,
      end_date: row.end_date,
      status: row.status,
    };

    // Состав для advisory-локов читаем ДО транзакции — как в approve/close.
    const anchors = monthAnchorsInRange(approval.start_date, approval.end_date);
    const employeeIds = row.payload.employees.map(e => e.identity.employee_id);
    const lockPairs = employeeIds.flatMap(employeeId => anchors.map(workDate => ({
      employeeId, workDate,
    })));
    if (lockPairs.length === 0) continue;

    try {
      const outcome = await withTimesheetSnapshotTransaction(lockPairs, async client => {
        const locked = (await client.query<{
          status: string; unlocked_at: string | null; version_dirty_at: string | null;
        }>(
          'SELECT status, unlocked_at, version_dirty_at FROM timesheet_approvals WHERE id = $1 FOR UPDATE',
          [approvalId],
        )).rows[0];
        if (!locked || locked.status !== 'approved' || locked.unlocked_at || locked.version_dirty_at) {
          return { kind: 'skipped' as const };
        }

        // Снимок мог появиться, пока шёл прогон, — повторно не пишем.
        const existing = (await client.query<{ version_id: number }>(
          `SELECT version_id FROM ${spec.snapshotTable} WHERE version_id = $1`,
          [row.version_id],
        )).rows[0];
        if (existing) return { kind: 'skipped' as const };

        if (!row.acked) {
          const { warnings } = await spec.write(
            client, Number(row.version_id), approval, row.payload,
          );
          return { kind: 'attached' as const, warnings };
        }

        // Подтверждённая редакция: копируем один-в-один с новым номером. payload и
        // content_hash те же — табель не менялся, изменилось только наличие снимка.
        const nextRevision = Number(row.revision) + 1;
        const cloned = (await client.query<{ id: number }>(
          `INSERT INTO timesheet_versions (
             approval_id, revision, content_hash, payload, scope_kind, department_id,
             manager_employee_id, start_date, end_date, employees_count, total_hours,
             membership_windows, source, created_by
           ) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,'backfill',NULL)
           RETURNING id`,
          [
            approvalId, nextRevision, row.content_hash, JSON.stringify(row.payload),
            row.scope_kind, approval.department_id, approval.manager_employee_id,
            approval.start_date, approval.end_date, Number(row.employees_count),
            Number(row.total_hours), JSON.stringify(row.membership_windows ?? {}),
          ],
        )).rows[0]!;
        const { warnings } = await spec.write(client, cloned.id, approval, row.payload);
        return { kind: 'revisioned' as const, revision: nextRevision, warnings };
      });

      if (outcome.kind === 'attached') {
        attached += 1;
        if (outcome.warnings > 0) withWarnings.push({ id: approvalId, count: outcome.warnings });
      } else if (outcome.kind === 'revisioned') {
        revisioned += 1;
        if (outcome.warnings > 0) withWarnings.push({ id: approvalId, count: outcome.warnings });
        console.log(`  approval ${approvalId}: новая редакция ${outcome.revision} (по ACK-нутой версии)`);
      }
    } catch (err) {
      failed.push({ id: approvalId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  console.log('\n=== Итог ===');
  console.log(`Снимков дописано без роста revision: ${attached}`);
  if (revisioned > 0) console.log(`Создано новых редакций (ACK-нутые): ${revisioned}`);
  if (skippedAcked > 0) {
    console.log(`\nПропущено подтверждённых редакций: ${skippedAcked}`);
    console.log('  Данные по ним 1С НЕ получит. Нужны — перезапустить с --notify-acked.');
  }
  if (withWarnings.length > 0) {
    console.log(`\nСнимки с замечаниями по данным: ${withWarnings.length}`);
    for (const item of withWarnings) console.log(`  approval ${item.id}: записей ${item.count}`);
  }
  if (failed.length > 0) {
    console.log(`\nОшибки: ${failed.length}`);
    for (const item of failed) console.log(`  approval ${item.id}: ${item.error}`);
  }
}
