/**
 * Одноразовый фикс: показать Бердиева Илхома Абдухакимовича (ID 286) в табеле
 * бр.Хайиткулов Ш.Й.У за период его работы (1–12 мая 2026 по СКУД).
 *
 * Диагностика (read-only прод-БД):
 *   286 числится уволенным (employment_status='fired'), но dismissal_date = NULL
 *   и нет строки в employee_dismissal_events → выпадает из фильтра табеля везде.
 *   Snapshot org_department_id = «Уволенные»; единственное назначение — в «Уволенные»
 *   [2026-04-21 → 2026-05-20]. Назначения в бр.Хайиткулов нет.
 *
 * Эталон рядом — коллега из той же бригады Рустамов (ID 2402): идентичное назначение
 *   в «Уволенные», но с employees.dismissal_date + employee_dismissal_events(from=бр.Хайиткулов).
 *   Отображается корректно. Бердиеву не хватает ровно этих двух записей.
 *
 * Логика табеля (listEmployeeMembershipsForDepartmentPeriod):
 *   - источник #1 employee_assignments, пересекающие период;
 *   - источник #2 employee_dismissal_events.from_department_id с dismissal_date >= startDate;
 *   - источник #3 snapshot employees.org_department_id;
 *   - фильтр: active ИЛИ (fired И dismissal_date >= startDate); transferred_out = dismissal_date + 1.
 *
 * Дата увольнения по решению пользователя — 18.05.2026 (виден в табеле бригады 1–18 мая;
 * часы по СКУД только 1–12, дни 13–18 пустые).
 *
 * Что делает скрипт (идемпотентно):
 *   INSERT employee_dismissal_events (from = бр.Хайиткулов, dismissal_date 18.05);
 *   UPDATE employees.dismissal_date = 18.05 (employment_status='fired' не трогаем).
 *   Назначение в «Уволенные» и snapshot НЕ трогаем — уже верны (совпадают с эталоном).
 *
 * Запуск (из build-контекста на проде, где есть src+tsx и .env сайта):
 *   cd fot-server
 *   npx tsx scripts/fix-berdiev-286-hayitkulov-dismissal.ts            # dry-run, только план
 *   npx tsx scripts/fix-berdiev-286-hayitkulov-dismissal.ts --migrate  # применить
 */
import { query, withTransaction } from '../src/config/postgres.js';

const HAYITKULOV = '7a89d8ad-f7a9-4f8d-84c0-a78c73e531b0'; // бр.Хайиткулов Ш.Й.У
const EMP_ID = 286; // Бердиев Илхом Абдухакимович
const DISMISSAL = '2026-05-18';

const APPLY = process.argv.includes('--migrate') || process.argv.includes('migrate');
const LOG = '[fix-berdiev]';

interface IAssignmentRow {
  id: string;
  org_department_id: string | null;
  effective_from: string;
  effective_to: string | null;
}

const fixBerdiev = async (): Promise<boolean> => {
  console.log(`\n${LOG} #${EMP_ID} Бердиев Илхом Абдухакимович — уволен ${DISMISSAL} из бр.Хайиткулов`);

  const emp = await query<{ dismissal_date: string | null; employment_status: string; org_department_id: string | null }>(
    `SELECT dismissal_date::text AS dismissal_date, employment_status, org_department_id
       FROM employees WHERE id = $1`,
    [EMP_ID],
  );
  if (emp.length === 0) {
    console.warn(`${LOG}   ПРОПУСК: сотрудник не найден.`);
    return false;
  }

  // Текущее состояние для подтверждения.
  const assignments = await query<IAssignmentRow>(
    `SELECT id,
            org_department_id,
            effective_from::text AS effective_from,
            effective_to::text   AS effective_to
       FROM employee_assignments
      WHERE employee_id = $1
      ORDER BY effective_from`,
    [EMP_ID],
  );
  console.log(`${LOG}   текущее: status=${emp[0].employment_status}, dismissal_date=${emp[0].dismissal_date ?? 'NULL'}, snapshot=${emp[0].org_department_id}`);
  console.log(`${LOG}   назначения: ${JSON.stringify(assignments)}`);

  const existingEvents = await query<{ id: string }>(
    `SELECT id FROM employee_dismissal_events
      WHERE employee_id = $1 AND cancelled = false AND from_department_id = $2`,
    [EMP_ID, HAYITKULOV],
  );

  const needEvent = existingEvents.length === 0;
  const needDate = emp[0].dismissal_date !== DISMISSAL;

  if (!needEvent && !needDate) {
    console.log(`${LOG}   уже на целевом состоянии — нечего менять.`);
    return false;
  }

  console.log(
    `${LOG}   dismissal_event(from=бр.Хайиткулов): ${needEvent ? 'INSERT' : 'уже есть'}; `
    + `employees.dismissal_date: ${emp[0].dismissal_date ?? 'NULL'} ⇒ ${DISMISSAL}`
    + ` (status=${emp[0].employment_status}, не трогаем)`,
  );

  if (!APPLY) return true;

  await withTransaction(async (client) => {
    if (needEvent) {
      await client.query(
        `INSERT INTO employee_dismissal_events (employee_id, dismissal_date, from_department_id)
         VALUES ($1, $2, $3)`,
        [EMP_ID, DISMISSAL, HAYITKULOV],
      );
    }
    if (needDate) {
      await client.query(
        `UPDATE employees SET dismissal_date = $1, updated_at = now() WHERE id = $2`,
        [DISMISSAL, EMP_ID],
      );
    }
  });

  console.log(`${LOG}   ПРИМЕНЕНО.`);
  return true;
};

const main = async (): Promise<void> => {
  console.log(`${LOG} режим: ${APPLY ? 'MIGRATE (запись в БД)' : 'DRY-RUN (только план)'}`);

  const changed = await fixBerdiev();

  console.log(`\n${LOG} итог: ${APPLY ? 'изменено' : 'к изменению'} = ${changed ? 1 : 0}/1.`);
  if (!APPLY && changed) {
    console.log(`${LOG} DRY-RUN: БД не изменялась. Запусти с --migrate для применения.`);
  }
};

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`${LOG} фатальная ошибка:`, err instanceof Error ? err.message : err);
    process.exit(1);
  });
