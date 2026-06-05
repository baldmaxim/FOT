/**
 * Одноразовый фикс: показать двух сотрудников в табеле бр.Вохидова Ш.А. за период их работы
 * в бригаде (до 12.05.2026 на объекте «ЖК Дом-56»). 13.05 оба ушли в СС-ГРУПП 10 ООО,
 * но в учёте этого не отразилось — оба выпали из табеля бр.Вохидова.
 *
 * Диагностика (read-only прод-БД) и решения пользователя:
 *   2131 Шерзода Усмон Абдурахим — оформлен уволенным, после 13.05 нигде не бейджится.
 *     Числится в «Уволенные», но dismissal_date = NULL и нет employee_dismissal_events →
 *     выпадает из фильтра табеля. РЕШЕНИЕ: оставить уволенным 13.05, восстановить видимость
 *     через employee_dismissal_events (механизм уже работает в проде — Тургунбоев 1809).
 *   1619 Сафаров Курбонали Абдуллоевич — активен, продолжил на ЗилАрт (объект СС-ГРУПП 10).
 *     Единственное назначение — открытое СС-ГРУПП 10 [2026-04-21→∞]; назначения в бр.Вохидова
 *     нет → невидим в её табеле. РЕШЕНИЕ: перевод в СС-ГРУПП 10 с 13.05, остаётся активным.
 *
 * Логика табеля (listEmployeeMembershipsForDepartmentPeriod):
 *   - источник #1 employee_assignments, пересекающие период;
 *   - источник #2 employee_dismissal_events.from_department_id с dismissal_date >= startDate;
 *   - источник #3 snapshot employees.org_department_id;
 *   - фильтр: active ИЛИ (fired И dismissal_date >= startDate); transferred_out = effective_to + 1.
 *
 * Что делает скрипт (идемпотентно):
 *   2131: INSERT employee_dismissal_events (from = бр.Вохидова, dismissal_date 13.05);
 *         UPDATE employees.dismissal_date = 13.05 (employment_status='fired' не трогаем).
 *   1619: UPDATE открытого СС-ГРУПП-назначения effective_from = 13.05;
 *         INSERT закрытого назначения бр.Вохидова [21.04 → 12.05].
 *         Порядок обязателен (открытую двигаем первой) — иначе триггер
 *         trg_ensure_no_overlapping_employee_assignments отклонит промежуточный оверлап.
 *
 * Запуск (из build-контекста на проде, где есть src+tsx и .env сайта):
 *   cd fot-server
 *   npx tsx scripts/fix-vohidov-brigade-2131-1619.ts                # dry-run, только план
 *   npx tsx scripts/fix-vohidov-brigade-2131-1619.ts --migrate      # применить
 */
import { query, withTransaction } from '../src/config/postgres.js';

const VOHIDOV = 'bf0ef678-141c-40ea-8f9e-859925ab5d71'; // бр.Вохидова Ш.А.
const SSGRUPP10 = '1b9ad712-93a0-4725-a0a4-7d91d4dd5148'; // СС-ГРУПП 10 ООО

// 2131 Шерзода Усмон Абдурахим — уволен 13.05.
const E2131_ID = 2131;
const E2131_DISMISSAL = '2026-05-13';

// 1619 Сафаров Курбонали Абдуллоевич — перевод в СС-ГРУПП 10 с 13.05.
const E1619_ID = 1619;
const E1619_VOHIDOV_FROM = '2026-04-21';
const E1619_VOHIDOV_TO = '2026-05-12'; // последний день в бр.Вохидова
const E1619_SSGRUPP_FROM = '2026-05-13'; // перевод в СС-ГРУПП 10

const APPLY = process.argv.includes('--migrate') || process.argv.includes('migrate');
const LOG = '[fix-vohidov]';

interface IAssignmentRow {
  id: string;
  org_department_id: string | null;
  effective_from: string;
  effective_to: string | null;
}

const loadAssignments = async (employeeId: number): Promise<IAssignmentRow[]> =>
  query<IAssignmentRow>(
    `SELECT id,
            org_department_id,
            effective_from::text AS effective_from,
            effective_to::text   AS effective_to
       FROM employee_assignments
      WHERE employee_id = $1
      ORDER BY effective_from`,
    [employeeId],
  );

/** 2131 — уволен из бр.Вохидова 13.05. */
const fix2131 = async (): Promise<boolean> => {
  console.log(`\n${LOG} #${E2131_ID} Шерзода Усмон Абдурахим — уволен ${E2131_DISMISSAL}`);

  const emp = await query<{ dismissal_date: string | null; employment_status: string }>(
    `SELECT dismissal_date::text AS dismissal_date, employment_status FROM employees WHERE id = $1`,
    [E2131_ID],
  );
  if (emp.length === 0) {
    console.warn(`${LOG}   ПРОПУСК: сотрудник не найден.`);
    return false;
  }

  const existingEvents = await query<{ id: string }>(
    `SELECT id FROM employee_dismissal_events
      WHERE employee_id = $1 AND cancelled = false AND from_department_id = $2`,
    [E2131_ID, VOHIDOV],
  );

  const needEvent = existingEvents.length === 0;
  const needDate = emp[0].dismissal_date !== E2131_DISMISSAL;

  if (!needEvent && !needDate) {
    console.log(`${LOG}   уже на целевом состоянии — нечего менять.`);
    return false;
  }

  console.log(
    `${LOG}   dismissal_event(from=бр.Вохидова): ${needEvent ? 'INSERT' : 'уже есть'}; `
    + `employees.dismissal_date: ${emp[0].dismissal_date ?? 'NULL'} ⇒ ${E2131_DISMISSAL}`
    + ` (status=${emp[0].employment_status}, не трогаем)`,
  );

  if (!APPLY) return true;

  await withTransaction(async (client) => {
    if (needEvent) {
      await client.query(
        `INSERT INTO employee_dismissal_events (employee_id, dismissal_date, from_department_id)
         VALUES ($1, $2, $3)`,
        [E2131_ID, E2131_DISMISSAL, VOHIDOV],
      );
    }
    if (needDate) {
      await client.query(
        `UPDATE employees SET dismissal_date = $1, updated_at = now() WHERE id = $2`,
        [E2131_DISMISSAL, E2131_ID],
      );
    }
  });

  console.log(`${LOG}   ПРИМЕНЕНО.`);
  return true;
};

/** 1619 — перевод бр.Вохидова → СС-ГРУПП 10 с 13.05 (остаётся активным). */
const fix1619 = async (): Promise<boolean> => {
  console.log(`\n${LOG} #${E1619_ID} Сафаров Курбонали Абдуллоевич — перевод в СС-ГРУПП 10 с ${E1619_SSGRUPP_FROM}`);

  const rows = await loadAssignments(E1619_ID);
  const openSS = rows.filter(r => r.org_department_id === SSGRUPP10 && r.effective_to === null);
  const anyVohidov = rows.filter(r => r.org_department_id === VOHIDOV);

  if (anyVohidov.length > 0) {
    console.log(`${LOG}   уже есть назначение в бр.Вохидова — считаем применённым, пропуск.`);
    return false;
  }
  if (openSS.length !== 1) {
    console.warn(
      `${LOG}   ПРОПУСК: ожидалось ровно 1 открытое назначение СС-ГРУПП 10, найдено ${openSS.length}. `
      + `Назначения: ${JSON.stringify(rows)}`,
    );
    return false;
  }

  const ss = openSS[0];
  if (E1619_SSGRUPP_FROM <= ss.effective_from) {
    console.warn(
      `${LOG}   ПРОПУСК: дата перевода ${E1619_SSGRUPP_FROM} не позже начала текущего назначения `
      + `${ss.effective_from}.`,
    );
    return false;
  }

  console.log(
    `${LOG}   СС-ГРУПП 10: [${ss.effective_from} → ∞]  ⇒  [${E1619_SSGRUPP_FROM} → ∞]`,
  );
  console.log(
    `${LOG}   бр.Вохидова: INSERT [${E1619_VOHIDOV_FROM} → ${E1619_VOHIDOV_TO}]`,
  );

  if (!APPLY) return true;

  await withTransaction(async (client) => {
    // 1) Открытое (СС-ГРУПП 10) — ПЕРВЫМ: сдвигаем начало вперёд, оверлапа нет.
    await client.query(
      `UPDATE employee_assignments SET effective_from = $1, updated_at = now() WHERE id = $2`,
      [E1619_SSGRUPP_FROM, ss.id],
    );
    // 2) Закрытое (бр.Вохидова) — ВТОРЫМ: вставляем [21.04 → 12.05] (< начала СС-ГРУПП).
    await client.query(
      `INSERT INTO employee_assignments (employee_id, org_department_id, effective_from, effective_to)
       VALUES ($1, $2, $3, $4)`,
      [E1619_ID, VOHIDOV, E1619_VOHIDOV_FROM, E1619_VOHIDOV_TO],
    );
  });

  const after = await loadAssignments(E1619_ID);
  console.log(`${LOG}   ПРИМЕНЕНО → ${JSON.stringify(after)}`);
  return true;
};

const main = async (): Promise<void> => {
  console.log(`${LOG} режим: ${APPLY ? 'MIGRATE (запись в БД)' : 'DRY-RUN (только план)'}`);

  const c1 = await fix2131();
  const c2 = await fix1619();

  console.log(`\n${LOG} итог: ${APPLY ? 'изменено' : 'к изменению'} = ${[c1, c2].filter(Boolean).length}/2.`);
  if (!APPLY && (c1 || c2)) {
    console.log(`${LOG} DRY-RUN: БД не изменялась. Запусти с --migrate для применения.`);
  }
};

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`${LOG} фатальная ошибка:`, err instanceof Error ? err.message : err);
    process.exit(1);
  });
