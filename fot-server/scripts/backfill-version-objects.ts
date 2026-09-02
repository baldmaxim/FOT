/**
 * Бэкфилл объектной разбивки для уже закрытых редакций табеля.
 *
 * Снимок объектов (timesheet_version_objects, миграция 263) создаётся вместе с версией.
 * У редакций, закрытых ДО внедрения, его нет, и метод
 * GET /api/public/v1/timesheets/{id}/objects отдаёт по ним OBJECT_BREAKDOWN_NOT_AVAILABLE.
 * Скрипт дописывает недостающие снимки.
 *
 * ЧТО ИМЕННО СЧИТАЕТСЯ. Целевые часы берутся из СОХРАНЁННОГО payload редакции, живыми
 * остаются только веса — объектные интервалы нигде не хранятся. Поэтому расхождение
 * живого расчёта с официальным табелем на бэкфилл не влияет и редакцию не порождает:
 * такое чинится штатным «Открыть → Закрыть», а не этим скриптом.
 *
 * ПРАВИЛО ACK — главное здесь. Состояние выгрузки считается сравнением ack.version_id
 * с текущим version_id, поэтому:
 *   - редакция НЕ подтверждена — снимок дописывается на месте, revision не растёт,
 *     состояние выгрузки не меняется;
 *   - редакция УЖЕ подтверждена — дописать нельзя: подача осталась бы exported, 1С об
 *     объектах не узнала бы, а старый ACK выглядел бы подтверждением данных, которых на
 *     момент ACK не существовало. По умолчанию такие пропускаются и попадают в отчёт;
 *     с --notify-acked создаётся новая редакция с тем же payload и content_hash — она
 *     штатно станет stale и вернётся в очередь 1С.
 *
 * Запуск (на проде — из /opt/fot-build, см. практику одноразовых скриптов):
 *   npx tsx scripts/backfill-version-objects.ts --dry-run
 *   npx tsx scripts/backfill-version-objects.ts
 *   npx tsx scripts/backfill-version-objects.ts --notify-acked
 *
 * Флаги:
 *   --dry-run          только показать, что будет сделано (и сколько подач станет stale)
 *   --from=YYYY-MM-DD  нижняя граница start_date (по умолчанию — глубина API, 3 месяца)
 *   --to=YYYY-MM-DD    верхняя граница start_date
 *   --limit=N          обработать не более N подач
 *   --notify-acked     поднимать revision у уже подтверждённых редакций
 *
 * Идемпотентен: редакции со снимком пропускаются, повторный прогон безопасен.
 */
import { query } from '../src/config/postgres.js';
import { withTimesheetSnapshotTransaction } from '../src/services/timesheet-snapshot-tx.js';
import {
  buildObjectsSnapshotForVersion,
  insertObjectsSnapshot,
  monthAnchorsInRange,
  type ITimesheetVersionPayload,
  type IVersionApproval,
} from '../src/services/timesheet-version.service.js';

/** Та же глубина, что ограничивает список API. */
const MAX_EXPORT_DEPTH_MONTHS = 3;

interface ICandidateRow {
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

function parseArgs(): {
  dryRun: boolean; from: string | null; to: string | null; limit: number | null; notifyAcked: boolean;
} {
  const args = process.argv.slice(2);
  const get = (name: string): string | null => {
    const found = args.find(a => a.startsWith(`--${name}=`));
    return found ? found.slice(name.length + 3) : null;
  };
  const limitRaw = get('limit');
  return {
    dryRun: args.includes('--dry-run'),
    from: get('from'),
    to: get('to'),
    limit: limitRaw && /^\d+$/.test(limitRaw) ? Number(limitRaw) : null,
    notifyAcked: args.includes('--notify-acked'),
  };
}

function defaultFromDate(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - MAX_EXPORT_DEPTH_MONTHS, 1))
    .toISOString().slice(0, 10);
}

const main = async (): Promise<void> => {
  const opts = parseArgs();
  const from = opts.from ?? defaultFromDate();
  const to = opts.to ?? '9999-12-31';

  // Берём только последнюю редакцию подачи: 1С работает с ней, старые не трогаем.
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
          SELECT 1 FROM timesheet_version_objects vo WHERE vo.version_id = v.id
        )
      ORDER BY a.start_date DESC, a.id DESC
      ${opts.limit ? `LIMIT ${opts.limit}` : ''}`,
    [from, to],
  );

  const ackedCount = rows.filter(row => row.acked).length;
  console.log(`Редакций без объектного снимка: ${rows.length} (период ${from}..${to})`);
  console.log(`  из них уже подтверждённых 1С: ${ackedCount}`);
  if (ackedCount > 0) {
    console.log(opts.notifyAcked
      ? `  --notify-acked: у них вырастет revision — ${ackedCount} подач станут stale и будут перезабраны 1С`
      : '  будут ПРОПУЩЕНЫ (для доставки объектов по ним нужен флаг --notify-acked)');
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
  const withConfigErrors: Array<{ id: number; count: number }> = [];
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
    const employeeIds = row.payload.employees.map(employee => employee.identity.employee_id);
    const lockPairs = employeeIds.flatMap(employeeId => anchors.map(workDate => ({
      employeeId, workDate,
    })));
    if (lockPairs.length === 0) continue;

    try {
      const outcome = await withTimesheetSnapshotTransaction(lockPairs, async client => {
        const locked = (await client.query<{ status: string; unlocked_at: string | null; version_dirty_at: string | null }>(
          'SELECT status, unlocked_at, version_dirty_at FROM timesheet_approvals WHERE id = $1 FOR UPDATE',
          [approvalId],
        )).rows[0];
        if (!locked || locked.status !== 'approved' || locked.unlocked_at || locked.version_dirty_at) {
          return { kind: 'skipped' as const };
        }

        // Снимок уже мог появиться, пока шёл прогон, — повторно не пишем.
        const existing = (await client.query<{ version_id: number }>(
          'SELECT version_id FROM timesheet_version_objects WHERE version_id = $1',
          [row.version_id],
        )).rows[0];
        if (existing) return { kind: 'skipped' as const };

        const objects = await buildObjectsSnapshotForVersion(client, approval, row.payload);

        if (!row.acked) {
          await insertObjectsSnapshot(client, Number(row.version_id), objects, 'backfill');
          return { kind: 'attached' as const, configErrors: objects.configErrors.length };
        }

        // Подтверждённая редакция: копируем её один-в-один с новым номером. payload и
        // content_hash те же — табель не менялся, изменилось только наличие объектов.
        const nextRevision = Number(row.revision) + 1;
        const cloned = (await client.query<{ id: number }>(
          `INSERT INTO timesheet_versions (
             approval_id, revision, content_hash, payload, scope_kind, department_id,
             manager_employee_id, start_date, end_date, employees_count, total_hours,
             membership_windows, source, created_by
           ) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,'backfill',NULL)
           RETURNING id`,
          [
            approvalId,
            nextRevision,
            row.content_hash,
            JSON.stringify(row.payload),
            row.scope_kind,
            approval.department_id,
            approval.manager_employee_id,
            approval.start_date,
            approval.end_date,
            Number(row.employees_count),
            Number(row.total_hours),
            JSON.stringify(row.membership_windows ?? {}),
          ],
        )).rows[0]!;
        await insertObjectsSnapshot(client, cloned.id, objects, 'backfill');
        return { kind: 'revisioned' as const, revision: nextRevision, configErrors: objects.configErrors.length };
      });

      if (outcome.kind === 'attached') {
        attached += 1;
        if (outcome.configErrors > 0) withConfigErrors.push({ id: approvalId, count: outcome.configErrors });
      } else if (outcome.kind === 'revisioned') {
        revisioned += 1;
        if (outcome.configErrors > 0) withConfigErrors.push({ id: approvalId, count: outcome.configErrors });
        console.log(`  approval ${approvalId}: новая редакция ${outcome.revision} (объекты по ACK-нутой версии)`);
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
    console.log('  Объекты по ним 1С НЕ получит. Нужны — перезапустить с --notify-acked.');
  }
  if (withConfigErrors.length > 0) {
    console.log(`\nСнимки с повреждённой настройкой режима: ${withConfigErrors.length}`);
    for (const item of withConfigErrors) console.log(`  approval ${item.id}: сотрудников ${item.count}`);
    console.log('  По ним метод отдаст 409 INVALID_EXPORT_MODE_CONFIG. Починить режим '
      + 'табелирования и закрыть табель заново — сам снимок не исправится.');
  }
  if (failed.length > 0) {
    console.log(`\nОшибки: ${failed.length}`);
    for (const item of failed) console.log(`  approval ${item.id}: ${item.error}`);
  }
};

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('backfill-version-objects failed:', err);
    process.exit(1);
  });
