/**
 * Одноразовый фикс: вернуть Эргашев Боходир Уткур Угли (ID 2178) в бр.Тоштемиров Т.Т.у.(2).
 *
 * Проблема (рассинхрон данных, read-only диагностика прод-БД):
 *   Сотрудник active, dismissal_date = NULL, отмечается по СКУД ежедневно (вплоть до 09.06.2026),
 *   назначения (employee_assignments) — все на бр.Тоштемиров Т.Т.у.(2) с апреля. НО:
 *     - employees.org_department_id указывает на «Уволенные» (надо → бригада);
 *     - единственная строка employee_department_access на бригаду имеет is_active = false (надо → true).
 *   Все 9 активных коллег по бригаде имеют org_department_id = бригада и is_active = true.
 *   Известный паттерн «реальный отдел затёрт на „Уволенные“ при синке/реорг Sigur».
 *
 * Что делает скрипт (идемпотентно, ровно 2 UPDATE для 1 сотрудника):
 *   1) employees.org_department_id: «Уволенные» → бр.Тоштемиров Т.Т.у.(2) (guard: только если ещё «Уволенные»).
 *   2) employee_department_access.is_active = true для (2178, бр.Тоштемиров).
 *   employee_assignments НЕ трогаем — членство/табель строятся по org_department_id + is_active.
 *
 * Запуск (из build-контекста на проде, где есть src+tsx и .env сайта):
 *   cd fot-server
 *   npx tsx scripts/fix-ergashev-2178-brigade.ts            # dry-run, только план
 *   npx tsx scripts/fix-ergashev-2178-brigade.ts --migrate  # применить
 */
import { query, withTransaction } from '../src/config/postgres.js';

const EMP_ID = 2178; // Эргашев Боходир Уткур Угли
const BRIGADE = 'bbaf9235-27f4-4e87-b647-c62942568628'; // бр.Тоштемиров Т.Т.у.(2)
const DISMISSED = 'ba4f7fb1-d24c-4e7f-9c75-4b27300ef6cc'; // «Уволенные»

const APPLY = process.argv.includes('--migrate') || process.argv.includes('migrate');
const LOG = '[fix-ergashev]';

interface IEmpRow {
  full_name: string;
  employment_status: string;
  dismissal_date: string | null;
  org_department_id: string | null;
}

interface IAccessRow {
  id: string;
  is_active: boolean;
}

const main = async (): Promise<void> => {
  console.log(`${LOG} режим: ${APPLY ? 'MIGRATE (запись в БД)' : 'DRY-RUN (только план)'}`);

  const emp = await query<IEmpRow>(
    `SELECT full_name, employment_status,
            dismissal_date::text AS dismissal_date,
            org_department_id::text AS org_department_id
       FROM employees WHERE id = $1`,
    [EMP_ID],
  );
  if (emp.length === 0) {
    console.error(`${LOG} сотрудник ID ${EMP_ID} не найден — выход.`);
    process.exit(1);
  }
  const e = emp[0];
  console.log(
    `${LOG} #${EMP_ID} ${e.full_name} | status=${e.employment_status} | `
    + `dismissal_date=${e.dismissal_date ?? 'NULL'} | dept=${e.org_department_id}`,
  );

  // Подстраховка: правим только если человек реально не уволен.
  if (e.employment_status !== 'active' || e.dismissal_date !== null) {
    console.warn(
      `${LOG} ВНИМАНИЕ: сотрудник не active/имеет dismissal_date — фикс рассчитан на active без даты. ПРОПУСК.`,
    );
    process.exit(0);
  }

  const access = await query<IAccessRow>(
    `SELECT id, is_active FROM employee_department_access
      WHERE employee_id = $1 AND department_id = $2`,
    [EMP_ID, BRIGADE],
  );

  const needDept = e.org_department_id === DISMISSED;
  const needActive = access.length > 0 && access[0].is_active === false;

  console.log(
    `${LOG} план: employees.org_department_id ${needDept ? '«Уволенные» ⇒ бр.Тоштемиров' : 'уже корректен'}; `
    + `employee_department_access.is_active ${needActive ? 'false ⇒ true' : (access.length === 0 ? 'строки нет (!)' : 'уже true')}`,
  );

  if (access.length === 0) {
    console.warn(`${LOG} ВНИМАНИЕ: нет строки employee_department_access на бригаду — будет создана.`);
  }

  if (!needDept && !needActive && access.length > 0) {
    console.log(`${LOG} уже на целевом состоянии — нечего менять.`);
    process.exit(0);
  }

  if (!APPLY) {
    console.log(`${LOG} DRY-RUN: БД не изменялась. Запусти с --migrate для применения.`);
    process.exit(0);
  }

  await withTransaction(async (client) => {
    if (needDept) {
      const r = await client.query(
        `UPDATE employees SET org_department_id = $1, updated_at = now()
          WHERE id = $2 AND org_department_id = $3`,
        [BRIGADE, EMP_ID, DISMISSED],
      );
      console.log(`${LOG}   employees: затронуто строк = ${r.rowCount}`);
    }
    if (access.length === 0) {
      await client.query(
        `INSERT INTO employee_department_access (employee_id, department_id, source, is_active)
         VALUES ($1, $2, 'manual_fix', true)`,
        [EMP_ID, BRIGADE],
      );
      console.log(`${LOG}   employee_department_access: INSERT (source=manual_fix, is_active=true)`);
    } else if (needActive) {
      const r = await client.query(
        `UPDATE employee_department_access SET is_active = true, updated_at = now()
          WHERE employee_id = $1 AND department_id = $2`,
        [EMP_ID, BRIGADE],
      );
      console.log(`${LOG}   employee_department_access: затронуто строк = ${r.rowCount}`);
    }
  });

  // Контроль после применения.
  const after = await query<{ dept: string | null; is_active: boolean | null }>(
    `SELECT d.name AS dept, eda.is_active
       FROM employees e
       LEFT JOIN org_departments d ON d.id = e.org_department_id
       LEFT JOIN employee_department_access eda
              ON eda.employee_id = e.id AND eda.department_id = $2
      WHERE e.id = $1`,
    [EMP_ID, BRIGADE],
  );
  console.log(`${LOG} ПРИМЕНЕНО → ${JSON.stringify(after[0])}`);
};

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`${LOG} фатальная ошибка:`, err instanceof Error ? err.message : err);
    process.exit(1);
  });
