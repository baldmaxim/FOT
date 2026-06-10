/**
 * Одноразовый фикс: перезаписывает отдел в артефактных назначениях на корень
 * «(СУ-10) ООО СУ-10» у 11 сотрудников секретариата/комендантской службы.
 *
 * Контекст: реорганизация в Sigur 20.04.2026 выкинула секретариатские ветки,
 * синк записал в employee_assignments назначения на корень («Синхронизация Sigur»).
 * Snapshot (employees.org_department_id) потом вернули (гарды + миграция 166),
 * но строки истории остались висеть на корне. Из-за этого в «Едином файле для 1С»
 * (bulk-резолвер listScopedMembersByDepartment, приоритет assignment > snapshot)
 * эти люди показываются в корне СУ-10 вместо реального отдела.
 *
 * Фикс: UPDATE org_department_id в строках на корень → реальный отдел.
 * Периоды строк НЕ меняем и НЕ закрываем (закрытие создало бы фейковые
 * переводы/дыры). Snapshot не трогаем — он везде корректен.
 *
 * Целевые отделы:
 *   - Душанова 567, Расстрыгина 1462 → Секретариат (= их snapshot)
 *   - Александрович 110, Лаптева 984, Матвеева 1093, Пахомова 1392,
 *     Смитская 1665, Имаметдинова 2346 → Секретариат-Объекты (= их snapshot)
 *   - Пацюкова 2393 (уволена 01.06) → Секретариат-Объекты
 *     (= employee_dismissal_events.from_department_id)
 *   - Полещук 1417, Хащеватский 1980 → Комендантская служба (решение HR;
 *     с 01.06 у них уже есть перевод в «Курьерскую службу»)
 *
 * Идемпотентно: повторный запуск не найдёт строк на корень и ничего не изменит.
 *
 * Запуск (из build-контекста на проде, где есть src+tsx и .env сайта):
 *   cd fot-server
 *   npx tsx scripts/fix-root-su10-assignments.ts            # dry-run, только план
 *   npx tsx scripts/fix-root-su10-assignments.ts --apply    # применить
 */
import { query, withTransaction } from '../src/config/postgres.js';

const ROOT_SU10 = '2cd8a403-6454-408b-9c2b-8a2db65c7511';      // (СУ-10) ООО СУ-10
const SECRETARIAT = '91dd729b-4491-4c47-b377-c6838e1887b4';    // Секретариат
const SECRETARIAT_OBJ = '47f45cbb-c168-451a-90d0-0975de59f787'; // Секретариат-Объекты
const KOMENDANTSKAYA = '6e251dcd-6097-42e6-8a72-156d5122d257';  // Комендантская служба

const CHANGE_REASON = 'Фикс артефакта реорганизации Sigur 20.04 (корень → реальный отдел)';

interface ITarget {
  employeeId: number;
  name: string;
  targetDeptId: string;
}

const TARGETS: ITarget[] = [
  { employeeId: 567, name: 'Душанова Елена Анатольевна', targetDeptId: SECRETARIAT },
  { employeeId: 1462, name: 'Расстрыгина Юлия Анатольевна', targetDeptId: SECRETARIAT },
  { employeeId: 110, name: 'Александрович Руслана', targetDeptId: SECRETARIAT_OBJ },
  { employeeId: 984, name: 'Лаптева Надежда Владимировна', targetDeptId: SECRETARIAT_OBJ },
  { employeeId: 1093, name: 'Матвеева Людмила Викторовна', targetDeptId: SECRETARIAT_OBJ },
  { employeeId: 1392, name: 'Пахомова Василина Валерьевна', targetDeptId: SECRETARIAT_OBJ },
  { employeeId: 1665, name: 'Смитская Юлия Александровна', targetDeptId: SECRETARIAT_OBJ },
  { employeeId: 2346, name: 'Имаметдинова Рузалия Рушановна', targetDeptId: SECRETARIAT_OBJ },
  { employeeId: 2393, name: 'Пацюкова Татьяна Владимировна', targetDeptId: SECRETARIAT_OBJ },
  { employeeId: 1417, name: 'Полещук Владимир Николаевич', targetDeptId: KOMENDANTSKAYA },
  { employeeId: 1980, name: 'Хащеватский Леонид Матвеевич', targetDeptId: KOMENDANTSKAYA },
];

const APPLY = process.argv.includes('--apply');

const LOG = '[fix-root-su10]';

interface IRootAssignmentRow {
  id: string;
  employee_id: number;
  effective_from: string;
  effective_to: string | null;
}

const main = async (): Promise<void> => {
  console.log(`${LOG} режим: ${APPLY ? 'APPLY (запись в БД)' : 'DRY-RUN (только план)'}`);

  // Контроль целевых отделов: существуют и активны.
  const deptIds = [...new Set(TARGETS.map(t => t.targetDeptId))];
  const depts = await query<{ id: string; name: string; is_active: boolean }>(
    'SELECT id, name, is_active FROM org_departments WHERE id = ANY($1::uuid[])',
    [deptIds],
  );
  const deptNameById = new Map(depts.map(d => [d.id, d.name]));
  for (const id of deptIds) {
    const dept = depts.find(d => d.id === id);
    if (!dept || !dept.is_active) {
      throw new Error(`целевой отдел ${id} не найден или неактивен`);
    }
  }

  const rows = await query<IRootAssignmentRow>(
    `SELECT id, employee_id,
            effective_from::text AS effective_from,
            effective_to::text   AS effective_to
       FROM employee_assignments
      WHERE employee_id = ANY($1::int[])
        AND org_department_id = $2
      ORDER BY employee_id, effective_from`,
    [TARGETS.map(t => t.employeeId), ROOT_SU10],
  );

  const updates: { rowId: string; targetDeptId: string }[] = [];
  let skipped = 0;

  for (const t of TARGETS) {
    const empRows = rows.filter(r => Number(r.employee_id) === t.employeeId);
    console.log(`\n${LOG} #${t.employeeId} ${t.name} → ${deptNameById.get(t.targetDeptId)}`);

    if (empRows.length === 0) {
      console.log(`${LOG}   строк на корень нет — уже исправлено, пропуск.`);
      skipped += 1;
      continue;
    }
    if (empRows.length > 1) {
      console.warn(
        `${LOG}   ПРОПУСК: ожидалась 1 строка на корень, найдено ${empRows.length} — `
        + 'разобрать вручную: ' + JSON.stringify(empRows),
      );
      skipped += 1;
      continue;
    }

    const row = empRows[0];
    console.log(
      `${LOG}   [${row.effective_from} → ${row.effective_to ?? '∞'}] корень СУ-10 ⇒ `
      + `${deptNameById.get(t.targetDeptId)}`,
    );
    updates.push({ rowId: row.id, targetDeptId: t.targetDeptId });
  }

  if (!APPLY) {
    console.log(`\n${LOG} итог: к изменению = ${updates.length}, пропущено = ${skipped}.`);
    if (updates.length > 0) {
      console.log(`${LOG} DRY-RUN: БД не изменялась. Запусти с --apply для применения.`);
    }
    return;
  }

  await withTransaction(async (client) => {
    for (const u of updates) {
      await client.query(
        `UPDATE employee_assignments
            SET org_department_id = $1,
                change_reason = $2,
                updated_at = now()
          WHERE id = $3`,
        [u.targetDeptId, CHANGE_REASON, u.rowId],
      );
    }
  });

  const left = await query<{ count: number }>(
    `SELECT count(*)::int AS count
       FROM employee_assignments
      WHERE employee_id = ANY($1::int[])
        AND org_department_id = $2`,
    [TARGETS.map(t => t.employeeId), ROOT_SU10],
  );
  console.log(
    `\n${LOG} итог: изменено = ${updates.length}, пропущено = ${skipped}, `
    + `осталось строк на корень у целевых сотрудников: ${left[0]?.count ?? '?'}.`,
  );
};

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`${LOG} фатальная ошибка:`, err instanceof Error ? err.message : err);
    process.exit(1);
  });
