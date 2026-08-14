/**
 * Разовый импорт закреплений «руководитель строительства → объект» из СКУД
 * в object_kpi_assignments.
 *
 * Зачем скрипт, а не runtime-fallback: текущие связи живут в employee_skud_object_access,
 * но это M:N без периода, означающая «место работы/видимость», и она же участвует в правах
 * на табель. KPI считает деньги — источник закреплений там должен быть один и явный.
 * После импорта обратной синхронизации нет ни в какую сторону.
 *
 * Запуск (dry-run, ничего не пишет):
 *   cd fot-server && npx tsx scripts/import-kpi-assignments-from-skud.ts --from=2026-09-01
 * Запись:
 *   cd fot-server && npx tsx scripts/import-kpi-assignments-from-skud.ts --from=2026-09-01 --apply
 *
 * Идемпотентен: повторный прогон не создаёт дублей (проверка по объект+сотрудник+source).
 */
import { query, withTransaction } from '../src/config/postgres.js';

interface ILinkRow {
  skud_object_id: string;
  object_name: string;
  employee_id: number;
  employee_name: string | null;
}

const parseArg = (name: string): string | null => {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
};

const main = async (): Promise<void> => {
  const validFrom = parseArg('from');
  const apply = process.argv.includes('--apply');

  if (!validFrom || !/^\d{4}-\d{2}-\d{2}$/.test(validFrom)) {
    console.error('Укажите дату запуска KPI: --from=YYYY-MM-DD');
    process.exitCode = 1;
    return;
  }

  // Только роль manager_obj: остальные роли к «руководителю строительства» отношения
  // не имеют, а закрепление даёт человеку доступ к деньгам объекта.
  const links = await query<ILinkRow>(
    `SELECT DISTINCT
            a.skud_object_id,
            o.name        AS object_name,
            a.employee_id,
            e.full_name   AS employee_name
       FROM employee_skud_object_access a
       JOIN skud_objects o   ON o.id = a.skud_object_id
       JOIN employees e      ON e.id = a.employee_id
       JOIN user_profiles up ON up.employee_id = e.id
       JOIN system_roles r   ON r.id = up.system_role_id
      WHERE r.code = 'manager_obj'
        AND a.is_active
        AND e.employment_status = 'active'
      ORDER BY o.name, e.full_name`,
  );

  const byObject = new Map<string, ILinkRow[]>();
  for (const link of links) {
    const list = byObject.get(link.skud_object_id) ?? [];
    list.push(link);
    byObject.set(link.skud_object_id, list);
  }

  const importable: ILinkRow[] = [];
  const conflicts: ILinkRow[][] = [];
  for (const list of byObject.values()) {
    // Двух руководителей на объекте одновременно быть не может (EXCLUDE в 241).
    // Автовыбор недопустим: он оказался бы случайным — такие объекты идут в конфликты.
    if (list.length > 1) conflicts.push(list);
    else importable.push(list[0]);
  }

  console.log(`\nСвязей manager_obj → объект: ${links.length}`);
  console.log(`Объектов к импорту: ${importable.length}`);
  console.log(`Объектов в конфликте (>1 руководителя): ${conflicts.length}\n`);

  for (const row of importable) {
    console.log(`  ${row.object_name} → ${row.employee_name ?? row.employee_id}`);
  }
  if (conflicts.length > 0) {
    console.log('\nКОНФЛИКТЫ (решать вручную, не импортируются):');
    for (const list of conflicts) {
      console.log(`  ${list[0].object_name}:`);
      for (const row of list) console.log(`      - ${row.employee_name ?? row.employee_id}`);
    }
  }

  if (!apply) {
    console.log('\nDry-run. Для записи повторите с флагом --apply\n');
    return;
  }

  let inserted = 0;
  let skipped = 0;
  for (const row of importable) {
    const done = await withTransaction(async (client) => {
      const existing = await client.query(
        `SELECT 1 FROM object_kpi_assignments
          WHERE skud_object_id = $1 AND employee_id = $2
            AND role_kind = 'construction_manager' AND source = 'skud_import'
          LIMIT 1`,
        [row.skud_object_id, row.employee_id],
      );
      if ((existing.rowCount ?? 0) > 0) return false;

      await client.query(
        `INSERT INTO object_kpi_assignments (
           skud_object_id, employee_id, role_kind, valid_from, valid_to, source, notes
         ) VALUES ($1, $2, 'construction_manager', $3::date, NULL, 'skud_import',
                   'Импорт из employee_skud_object_access')`,
        [row.skud_object_id, row.employee_id, validFrom],
      );
      return true;
    });

    if (done) inserted += 1;
    else skipped += 1;
  }

  // Историю до даты запуска не выдумываем: valid_from всегда = дате запуска KPI.
  console.log(`\nЗаписано: ${inserted}, пропущено (уже есть): ${skipped}\n`);
};

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('[import-kpi-assignments] ошибка:', error);
    process.exit(1);
  });
