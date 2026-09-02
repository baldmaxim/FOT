/**
 * Бэкфилл руководителей отдела для уже закрытых редакций табеля.
 *
 * Снимок (timesheet_version_managers, миграция 264) создаётся вместе с версией. У
 * редакций, закрытых ДО внедрения, его нет, и метод
 * GET /api/public/v1/timesheets/{id}/managers отвечает MANAGERS_NOT_AVAILABLE.
 *
 * ВАЖНО ПРО СМЫСЛ ДАННЫХ. В employee_department_access нет периодов действия — только
 * is_active. Восстановить, кто был руководителем НА ДАТУ закрытия редакции, физически
 * невозможно. Поэтому снимок пишется с snapshot_source = 'backfill_current_state' и
 * фактическим resolved_at: это состояние на момент прогона, а не историческое. 1С видит
 * разницу и не принимает такие данные за исторические.
 *
 * Состав сотрудников и период берутся из СОХРАНЁННОГО payload версии — живой расчёт
 * табель не подменяет.
 *
 * Запуск (на проде — из /opt/fot-build/fot-server, иначе dotenv не найдёт .env):
 *   npx tsx scripts/backfill-version-managers.ts --dry-run
 *   npx tsx scripts/backfill-version-managers.ts
 *   npx tsx scripts/backfill-version-managers.ts --notify-acked
 *
 * Флаги: --dry-run, --from=YYYY-MM-DD, --to=YYYY-MM-DD, --limit=N, --notify-acked.
 * Идемпотентен: редакции со снимком пропускаются, повторный прогон безопасен.
 */
import {
  buildManagersSnapshotForVersion,
  insertManagersSnapshot,
} from '../src/services/timesheet-version.service.js';
import {
  parseBackfillArgs,
  runVersionSnapshotBackfill,
} from './lib/version-snapshot-backfill.js';

const main = async (): Promise<void> => {
  await runVersionSnapshotBackfill(
    {
      title: 'Руководители отдела',
      snapshotTable: 'timesheet_version_managers',
      async write(client, versionId, approval, payload) {
        const managers = await buildManagersSnapshotForVersion(client, approval, payload);
        await insertManagersSnapshot(client, versionId, managers, 'backfill_current_state');
        // Замечание = сотрудник без руководителя: величина штатная (у ЛИНИЯ и
        // ЛИНИЯ-Общестрой руководитель не назначен вовсе), но её полезно видеть в отчёте.
        return { warnings: managers.withoutManager };
      },
    },
    parseBackfillArgs(),
  );
};

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('backfill-version-managers failed:', err);
    process.exit(1);
  });
