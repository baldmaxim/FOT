/**
 * Дозаполнение основы расчёта «К выплате (ФОТ)» (миграция 331) у редакций, закрытых до деплоя: последние редакции
 * подач с периодом от --from (по умолчанию 2026-05-01). Графики и норма — НЫНЕШНИЕ, а не на дату закрытия:
 * quality = 'reconstructed', на экране — «Восстановлено по текущим графикам». Пишет только там, где основы
 * сотрудника за месяц нет совсем: снятую при закрытии (materialized) не трогает. Повторный запуск — без эффекта.
 *
 * Запуск: cd fot-server && npx tsx scripts/backfill-payroll-basis.ts [--from=2026-05-01]          — сухой прогон
 *         cd fot-server && npx tsx scripts/backfill-payroll-basis.ts [--from=2026-05-01] --apply  — запись
 */
import { closeDb, pool, query, withTransaction } from '../src/config/postgres.js';
import { buildPayrollBasisDrafts, insertPayrollBasis } from '../src/services/payroll/payroll-basis.service.js';
import type { ITimesheetVersionPayload } from '../src/services/timesheet-version.service.js';

const TAG = '[backfill-payroll-basis]';

const argValue = (name: string): string | null => {
  const prefix = `--${name}=`;
  return process.argv.find(arg => arg.startsWith(prefix))?.slice(prefix.length) ?? null;
};

const main = async (): Promise<void> => {
  const apply = process.argv.includes('--apply');
  const from = argValue('from') ?? '2026-05-01';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) throw new Error(`--from=${from}: нужна дата ГГГГ-ММ-ДД`);

  // Последняя редакция каждой подачи; у которой основа уже есть у всех — пропуск решит insertPayrollBasis.
  const versions = await query<{ id: string; approval_id: string; start_date: string; end_date: string }>(
    `SELECT DISTINCT ON (v.approval_id) v.id::text AS id, v.approval_id::text AS approval_id,
            to_char(v.start_date, 'YYYY-MM-DD') AS start_date, to_char(v.end_date, 'YYYY-MM-DD') AS end_date
       FROM timesheet_versions v
      WHERE v.start_date >= $1::date
      ORDER BY v.approval_id, v.revision DESC`,
    [from],
  );
  console.log(`${TAG} ${apply ? 'ЗАПИСЬ' : 'сухой прогон'}: редакций с ${from} — ${versions.length}`);

  let written = 0;
  let failed = 0;
  for (const version of versions) {
    try {
      const row = (await pool().query<{ payload: ITimesheetVersionPayload }>(
        'SELECT payload FROM timesheet_versions WHERE id = $1',
        [version.id],
      )).rows[0];
      if (!row) continue;
      const drafts = await buildPayrollBasisDrafts(pool(), row.payload);
      if (!apply) {
        const existing = await query<{ employee_id: number; month: string }>(
          `SELECT DISTINCT employee_id, to_char(month, 'YYYY-MM-DD') AS month
             FROM timesheet_version_payroll_basis WHERE version_id = $1`,
          [version.id],
        );
        const has = new Set(existing.map(item => `${item.employee_id}|${item.month}`));
        written += drafts.filter(draft => !has.has(`${draft.employeeId}|${draft.month}`)).length;
        continue;
      }
      written += await withTransaction(client => insertPayrollBasis(client, Number(version.id), drafts, {
        quality: 'reconstructed',
        reason: 'backfill',
        mode: 'missing',
      }));
    } catch (error) {
      failed += 1;
      console.error(`${TAG} версия ${version.id} (подача ${version.approval_id}, ${version.start_date}..${version.end_date}):`,
        (error as Error).message);
    }
  }
  console.log(`${TAG} ${apply ? 'записано' : 'будет записано'} строк основы: ${written}, ошибок: ${failed}`);
};

main()
  .catch(error => {
    console.error(`${TAG} фатальная ошибка:`, error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
