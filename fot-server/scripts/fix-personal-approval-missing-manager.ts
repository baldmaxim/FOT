/**
 * Одноразовый бэкфилл: добавить самого руководителя в снимок персональной подачи
 * табеля (timesheet_approval_employees), если его там нет.
 *
 * Причина: resolvePersonalSubmissionContext раньше собирал состав персональной
 * подачи «по людям» только из прямых подчинённых, без самого руководителя —
 * поэтому у проверяющего (HR) руководитель не отображался. Код исправлен
 * going-forward; этот скрипт чинит уже поданные снимки, ждущие проверки.
 *
 * Скоуп (узкий, по согласованию): только подачи в статусе 'submitted' за период
 * 01–15 июня 2026 (start_date=2026-06-01, end_date=2026-06-15), где руководителя
 * нет в снимке. Черновики/отклонённые пересоберутся при переподаче, утверждённые
 * не трогаем. Идемпотентно (ON CONFLICT DO NOTHING), статус подачи не меняется.
 *
 * Запуск (из build-контекста на проде, где есть src+tsx и .env сайта):
 *   cd fot-server
 *   npx tsx scripts/fix-personal-approval-missing-manager.ts            # dry-run, только план
 *   npx tsx scripts/fix-personal-approval-missing-manager.ts --migrate  # применить
 */
import { query, withTransaction } from '../src/config/postgres.js';

const PERIOD_START = '2026-06-01';
const PERIOD_END = '2026-06-15';

const APPLY = process.argv.includes('--migrate') || process.argv.includes('migrate');
const LOG = '[fix-personal-approval-manager]';

interface ITargetRow {
  approval_id: number;
  manager_employee_id: number;
  full_name: string;
  start_txt: string;
  end_txt: string;
}

const main = async (): Promise<void> => {
  console.log(`${LOG} режим: ${APPLY ? 'MIGRATE (запись в БД)' : 'DRY-RUN (только план)'}`);
  console.log(`${LOG} скоуп: status='submitted', период ${PERIOD_START}…${PERIOD_END}, руководитель отсутствует в снимке`);

  const targets = await query<ITargetRow>(
    `SELECT a.id AS approval_id,
            a.manager_employee_id,
            e.full_name,
            a.start_date::text AS start_txt,
            a.end_date::text   AS end_txt
       FROM timesheet_approvals a
       JOIN employees e ON e.id = a.manager_employee_id
      WHERE a.manager_employee_id IS NOT NULL
        AND a.status = 'submitted'
        AND a.start_date = $1::date
        AND a.end_date   = $2::date
        AND NOT EXISTS (
          SELECT 1 FROM timesheet_approval_employees s
           WHERE s.approval_id = a.id AND s.employee_id = a.manager_employee_id
        )
      ORDER BY a.id`,
    [PERIOD_START, PERIOD_END],
  );

  if (targets.length === 0) {
    console.log(`${LOG} нет подходящих подач — нечего менять.`);
    process.exit(0);
  }

  console.log(`${LOG} затрагиваемых подач: ${targets.length}`);
  for (const t of targets) {
    console.log(
      `${LOG}   approval #${t.approval_id} | руководитель #${t.manager_employee_id} ${t.full_name} | ${t.start_txt}…${t.end_txt}`,
    );
  }

  if (!APPLY) {
    console.log(`${LOG} DRY-RUN: БД не изменялась. Запусти с --migrate для применения.`);
    process.exit(0);
  }

  const inserted = await withTransaction(async (client) => {
    const r = await client.query(
      `INSERT INTO timesheet_approval_employees (approval_id, employee_id, full_name)
         SELECT a.id, a.manager_employee_id, e.full_name
           FROM timesheet_approvals a
           JOIN employees e ON e.id = a.manager_employee_id
          WHERE a.manager_employee_id IS NOT NULL
            AND a.status = 'submitted'
            AND a.start_date = $1::date
            AND a.end_date   = $2::date
            AND NOT EXISTS (
              SELECT 1 FROM timesheet_approval_employees s
               WHERE s.approval_id = a.id AND s.employee_id = a.manager_employee_id
            )
         ON CONFLICT (approval_id, employee_id) DO NOTHING`,
      [PERIOD_START, PERIOD_END],
    );
    return r.rowCount ?? 0;
  });

  console.log(`${LOG} ПРИМЕНЕНО → добавлено строк снимка: ${inserted}`);
};

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`${LOG} фатальная ошибка:`, err instanceof Error ? err.message : err);
    process.exit(1);
  });
