/**
 * Откат выгрузки ведомостей выплаты, пришедшей из 1С по API (payroll_1c_payout_api_batches, миграция 379).
 * Без --apply — только проверка и список того, что вернётся; с --apply — откат одной транзакцией.
 * Откат отказывает целиком, если после выгрузки эти ведомости меняли (новая версия, отмена, правка).
 *
 *   npx tsx scripts/rollback-payouts-api-batch.ts --batch <uuid> --by "Фамилия И. О." [--apply]
 */

const argValue = (name: string): string | null => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
};

const load = async <T>(path: string): Promise<T> => {
  const module = await import(path) as Record<string, unknown> & { default?: Record<string, unknown> };
  return { ...(module.default ?? {}), ...module } as T;
};

async function main(): Promise<void> {
  const batchId = argValue('--batch');
  const by = argValue('--by');
  const apply = process.argv.includes('--apply');
  if (!batchId || !/^[0-9a-f-]{36}$/i.test(batchId)) throw new Error('Нужен --batch <uuid выгрузки>');
  if (!by || by.trim() === '') throw new Error('Нужен --by «кто откатывает»');
  const pg = await load<typeof import('../src/config/postgres.js')>('../src/config/postgres.js');
  const rollback = await load<typeof import('../src/services/payroll/payroll-1c-payouts.api-rollback.js')>(
    '../src/services/payroll/payroll-1c-payouts.api-rollback.js');
  try {
    const result = await rollback.rollbackPayoutApiBatch({ batchId: batchId.toLowerCase(), by: by.trim(), apply });
    console.log(JSON.stringify(result, null, 2));
    console.log(apply ? 'Откат выполнен.' : 'Проверка: откат возможен. Для отката добавьте --apply.');
  } finally {
    await pg.closeDb();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
