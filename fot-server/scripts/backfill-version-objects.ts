/**
 * Бэкфилл объектной разбивки для уже закрытых редакций табеля.
 *
 * Снимок (timesheet_version_objects, миграция 263) создаётся вместе с версией. У
 * редакций, закрытых ДО внедрения, его нет, и метод
 * GET /api/public/v1/timesheets/{id}/objects отдаёт OBJECT_BREAKDOWN_NOT_AVAILABLE.
 *
 * ЧТО ИМЕННО СЧИТАЕТСЯ. Целевые часы берутся из СОХРАНЁННОГО payload редакции, живыми
 * остаются только веса — объектные интервалы нигде не хранятся. Поэтому расхождение
 * живого расчёта с официальным табелем на бэкфилл не влияет и редакцию не порождает:
 * такое чинится штатным «Открыть → Закрыть», а не этим скриптом.
 *
 * Обход (выборка кандидатов, транзакция, правило ACK, отчёт) общий с бэкфиллом
 * руководителей — см. lib/version-snapshot-backfill.ts.
 *
 * Запуск (на проде — из /opt/fot-build/fot-server, иначе dotenv не найдёт .env):
 *   npx tsx scripts/backfill-version-objects.ts --dry-run
 *   npx tsx scripts/backfill-version-objects.ts
 *   npx tsx scripts/backfill-version-objects.ts --notify-acked
 *
 * Флаги: --dry-run, --from=YYYY-MM-DD, --to=YYYY-MM-DD, --limit=N, --notify-acked.
 * Идемпотентен: редакции со снимком пропускаются, повторный прогон безопасен.
 */
import {
  buildObjectsSnapshotForVersion,
  insertObjectsSnapshot,
} from '../src/services/timesheet-version.service.js';
import {
  parseBackfillArgs,
  runVersionSnapshotBackfill,
} from './lib/version-snapshot-backfill.js';

const main = async (): Promise<void> => {
  await runVersionSnapshotBackfill(
    {
      title: 'Объектная разбивка',
      snapshotTable: 'timesheet_version_objects',
      async write(client, versionId, approval, payload) {
        const objects = await buildObjectsSnapshotForVersion(client, approval, payload);
        await insertObjectsSnapshot(client, versionId, objects, 'backfill');
        // Замечание = повреждённая настройка режима «объект»: по таким редакциям метод
        // отдаст 409 INVALID_EXPORT_MODE_CONFIG, их надо разобрать отдельно.
        return { warnings: objects.configErrors.length };
      },
    },
    parseBackfillArgs(),
  );
};

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('backfill-version-objects failed:', err);
    process.exit(1);
  });
