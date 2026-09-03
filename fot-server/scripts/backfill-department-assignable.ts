/**
 * Разовый бэкфилл org_departments.is_assignable (миграция 266).
 *
 * Миграция ставит DEFAULT true всем строкам, а это неверно: отдел вне
 * разрешённого поддерева фильтра синхронизации назначаемым быть не должен.
 * Скрипт прогоняет ту же реконсиляцию, что и сохранение фильтра, по текущему
 * whitelist — без изменения самого фильтра.
 *
 * Идемпотентен: повторный запуск не меняет ни одной строки (UPDATE ... IS
 * DISTINCT FROM). По умолчанию сухой прогон.
 *
 * Запуск:
 *   cd fot-server && npx tsx scripts/backfill-department-assignable.ts          # показать план
 *   cd fot-server && npx tsx scripts/backfill-department-assignable.ts --apply  # применить
 */
import { withTransaction } from '../src/config/postgres.js';
import { reconcileDepartmentsActivity } from '../src/services/sigur-sync-filter.service.js';

const apply = process.argv.includes('--apply');

const main = async (): Promise<void> => {
  const result = await withTransaction(async client => {
    const { rows: filterRows } = await client.query<{ sigur_department_id: number }>(
      'SELECT sigur_department_id FROM skud_sync_department_filter',
    );
    if (filterRows.length === 0) {
      throw new Error('Фильтр синхронизации пуст — бэкфилл погасил бы все отделы Sigur. Прервано.');
    }

    const reconciled = await reconcileDepartmentsActivity(
      client,
      filterRows.map(row => row.sigur_department_id),
    );

    if (!apply) {
      // Сухой прогон: считаем изменения и откатываем.
      throw new DryRunResult(reconciled);
    }

    return reconciled;
  }).catch(error => {
    if (error instanceof DryRunResult) return error.result;
    throw error;
  });

  console.log(
    `${apply ? 'Применено' : 'Сухой прогон'}: активировано ${result.activated}, деактивировано ${result.deactivated},`
    + ` назначаемость изменена у ${result.assignableChanged}, предупреждений ${result.warnings.length}`,
  );

  for (const warning of result.warnings) {
    console.log(`  оставлен активным ради сотрудников: ${warning.name} (${warning.employees})`);
  }

  if (!apply) {
    console.log('Изменения откачены. Повторите с --apply, чтобы записать.');
  }
};

class DryRunResult extends Error {
  readonly result: Awaited<ReturnType<typeof reconcileDepartmentsActivity>>;

  constructor(result: Awaited<ReturnType<typeof reconcileDepartmentsActivity>>) {
    super('dry-run');
    this.result = result;
  }
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error('Ошибка бэкфилла:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
