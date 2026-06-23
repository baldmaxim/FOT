/**
 * Одноразовая чистка: снимает все назначенные «объекты входа» у НАЧАЛЬНИКОВ УЧАСТКОВ.
 *
 * Объекты назначаются на вкладке «Назначения сотрудников» → под-вкладка «Объекты»
 * (PUT /api/admin/employees/:id/skud-objects → replaceEmployeeObjectAccess →
 *  таблица public.employee_skud_object_access). Снятие галочек в UI = is_active=false;
 * скрипт делает ровно это (мягкое снятие, обратимо повторным назначением).
 *
 * НЕ затрагивает:
 *   - сами аккаунты (user_profiles / app_auth.users);
 *   - назначенные бригады/отделы (employee_department_access) — это другая таблица;
 *   - назначения объектов другим должностям (только начальники участков по position_id).
 *
 * Кто такой «начальник участка»: сотрудник, чья должность (positions.name) подходит под
 * тот же предикат, что и в предпросмотре — содержит «начальник … участк…» ИЛИ «Нач.участка».
 * Это даёт 14 должностей (общестроительный/отделочный/фасадный/электромонтажный/… участки,
 * «Нач.участка», «начальник участка»). Тестовая запись «Тест Нач уч» ВКЛЮЧЕНА.
 *
 * Идемпотентно: повторный запуск найдёт 0 активных строк.
 *
 * Запуск (из build-контекста на проде, где есть src+tsx и .env сайта):
 *   cd fot-server
 *   npx tsx scripts/clear-site-chief-object-assignments.ts            # DRY-RUN (только план)
 *   npx tsx scripts/clear-site-chief-object-assignments.ts --migrate  # ПРИМЕНИТЬ (is_active=false)
 */
import { query, execute } from '../src/config/postgres.js';

const LOG = '[clear-chief-objects]';
const APPLY = process.argv.includes('--migrate') || process.argv.includes('migrate');

/** Тот же предикат, что в предпросмотре. ILIKE — регистронезависимо. */
const CHIEF_POSITION_PREDICATE = `(p.name ILIKE '%начальник%участк%' OR p.name ILIKE 'нач.участка%')`;

interface ITargetRow {
  row_id: string;
  employee_id: number;
  full_name: string | null;
  position_name: string | null;
  object_name: string | null;
}

const main = async (): Promise<void> => {
  console.log(`${LOG} режим: ${APPLY ? 'MIGRATE (is_active=false в БД)' : 'DRY-RUN (только план)'}`);

  // Активные приписки объектов у начальников участков + имена объектов.
  const targets = await query<ITargetRow>(
    `SELECT esa.id::text       AS row_id,
            e.id               AS employee_id,
            e.full_name        AS full_name,
            p.name             AS position_name,
            o.name             AS object_name
       FROM public.employee_skud_object_access esa
       JOIN public.employees  e ON e.id = esa.employee_id
       JOIN public.positions  p ON p.id = e.position_id
       LEFT JOIN public.skud_objects o ON o.id = esa.skud_object_id
      WHERE esa.is_active = true
        AND ${CHIEF_POSITION_PREDICATE}
      ORDER BY e.full_name, o.name`,
  );

  if (targets.length === 0) {
    console.log(`${LOG} активных приписок объектов у начальников участков нет — нечего снимать (идемпотентно).`);
    return;
  }

  // Группировка по сотруднику для печати плана.
  const byEmployee = new Map<number, { full_name: string | null; position_name: string | null; objects: string[] }>();
  for (const t of targets) {
    let bucket = byEmployee.get(t.employee_id);
    if (!bucket) {
      bucket = { full_name: t.full_name, position_name: t.position_name, objects: [] };
      byEmployee.set(t.employee_id, bucket);
    }
    bucket.objects.push(t.object_name ?? '(объект удалён/не найден)');
  }

  console.log(`${LOG} начальников участков с объектами: ${byEmployee.size}; строк-приписок к снятию: ${targets.length}`);
  console.log(`${LOG} ─────────────────────────────────────────────────────────────`);
  let i = 0;
  for (const { full_name, position_name, objects } of byEmployee.values()) {
    i += 1;
    console.log(`${LOG} ${String(i).padStart(2, ' ')}. ${full_name ?? '(без ФИО)'}`);
    console.log(`${LOG}     Должность: ${position_name ?? '(не указана)'}`);
    console.log(`${LOG}     Снимаются объекты: ${objects.join(', ')}`);
  }
  console.log(`${LOG} ─────────────────────────────────────────────────────────────`);

  if (!APPLY) {
    console.log(`${LOG} DRY-RUN: БД не изменялась. Запусти с --migrate для снятия (is_active=false).`);
    return;
  }

  // Снимаем ровно найденные строки (по их id) — точно и идемпотентно.
  const rowIds = targets.map(t => t.row_id);
  const now = new Date().toISOString();
  await execute(
    `UPDATE public.employee_skud_object_access
        SET is_active = false, updated_at = $1::timestamptz
      WHERE id = ANY($2::uuid[]) AND is_active = true`,
    [now, rowIds],
  );
  console.log(`${LOG} снято (is_active=false) строк: ${rowIds.length} у ${byEmployee.size} начальников участков.`);
  console.log(`${LOG} ГОТОВО. Бригады/отделы и аккаунты не затронуты.`);
};

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`${LOG} фатальная ошибка:`, err instanceof Error ? err.message : err);
    process.exit(1);
  });
