// Этап 2: пересборка версий табеля, в которые попали чужие дни.
//
// Контекст. До правки владения днём сборщик версии брал состав из снимка подачи и
// копировал ВСЕ дни периода. Сотрудник, переведённый в середине периода, уносил в
// выгрузку старой бригады дни, отработанные уже в новой, — одна пара (сотрудник,
// дата) попадала в две версии, и 1С получала часы дважды.
//
// Правка сборщика чинит только БУДУЩИЕ редакции: новая редакция создаётся лишь при
// «Утвердить» и «Закрыть». Уже созданные версии остаются с чужими днями, пока их
// не пересоберут. Скрипт находит такие подачи и помечает их операторской пометкой
// (markVersionDirtyForOperatorRebuild) — дальше их разбирает фоновый воркер
// timesheet-version-rebuild.service (батч 20, тик 60 сек).
//
// Пока подача помечена, публичный API отвечает 409 TIMESHEET_REBUILD_PENDING —
// это штатное состояние протокола, 1С повторит запрос позже. Останавливать обмен
// не требуется, но у затронутых подач вырастет revision: сторону 1С надо
// предупредить, чтобы перечитала их.
//
// Usage:
//   npx tsx scripts/rebuild-versions-with-foreign-days.ts               # dry-run: только список
//   npx tsx scripts/rebuild-versions-with-foreign-days.ts --yes         # пометить все
//   npx tsx scripts/rebuild-versions-with-foreign-days.ts --yes --only=1551,1485
//                                                        # пометить только указанные подачи
//
// На проде запускать из /opt/fot-build (там лежат src и tsx).

import { query, getPool, closeDb } from '../src/config/postgres.js';
import { markVersionDirtyForOperatorRebuild } from '../src/services/timesheet-version-maintenance.js';

const APPLY = process.argv.includes('--yes');

// Точечный прогон: сначала пилот на одной-двух подачах, потом остальные.
const ONLY = (() => {
  const arg = process.argv.find(a => a.startsWith('--only='));
  if (!arg) return null;
  const ids = arg.slice('--only='.length).split(',').map(Number).filter(id => Number.isSafeInteger(id) && id > 0);
  return ids.length > 0 ? new Set(ids) : null;
})();

/**
 * Подачи, в последней редакции которых есть дни, не принадлежащие их отделу.
 *
 * Правило владения повторяет timesheet-day-ownership.service:
 *  - доказательством считается назначение, покрывающее дату;
 *  - назначение в архивную папку «Уволенные» доказательством НЕ является (freeze
 *    переписывает открытую строку со старой датой, и реально отработанные дни
 *    уволенного иначе выглядели бы чужими);
 *  - день чужой, если покрывающие назначения есть, но ни одно не ведёт в отдел
 *    подачи или его потомок.
 */
const FOREIGN_DAYS_SQL = `
WITH RECURSIVE anc AS (
  SELECT id AS dept_id, id AS anc_id, parent_id, 1 AS depth FROM org_departments
  UNION
  SELECT a.dept_id, d.id, d.parent_id, a.depth + 1
    FROM anc a JOIN org_departments d ON d.id = a.parent_id
   WHERE a.depth < 32
), archive AS (
  SELECT NULLIF(s.value, '')::uuid AS dept_id
    FROM system_settings s
   WHERE s.key = 'employees_archive_department_id'
   LIMIT 1
), proof AS (
  SELECT ea.employee_id, ea.org_department_id, ea.effective_from, ea.effective_to
    FROM employee_assignments ea
   WHERE ea.org_department_id IS NOT NULL
     AND NOT EXISTS (
           SELECT 1 FROM anc a JOIN archive ar ON ar.dept_id = a.anc_id
            WHERE a.dept_id = ea.org_department_id
         )
), latest AS (
  SELECT DISTINCT ON (approval_id) id, approval_id, department_id, revision
    FROM timesheet_versions ORDER BY approval_id, revision DESC
), vdays AS (
  SELECT l.approval_id, l.department_id, l.revision,
         (x->'identity'->>'employee_id')::int AS employee_id,
         d.key::date AS work_date,
         COALESCE((d.value->>'hours')::numeric, 0) AS hours
    FROM latest l
    JOIN timesheet_versions v ON v.id = l.id,
    LATERAL jsonb_array_elements(v.payload->'employees') x,
    LATERAL jsonb_each(x->'days') d
   WHERE l.department_id IS NOT NULL
)
SELECT vd.approval_id,
       vd.revision,
       dep.name AS department_name,
       a.start_date::text AS start_date,
       a.end_date::text AS end_date,
       a.status,
       a.unlocked_at IS NOT NULL AS unlocked,
       count(*)::int AS foreign_days,
       count(*) FILTER (WHERE vd.hours > 0)::int AS foreign_days_with_hours,
       round(sum(vd.hours), 2)::float8 AS foreign_hours,
       count(DISTINCT vd.employee_id)::int AS employees
  FROM vdays vd
  JOIN timesheet_approvals a ON a.id = vd.approval_id
  LEFT JOIN org_departments dep ON dep.id = vd.department_id
 WHERE EXISTS (
         SELECT 1 FROM proof p
          WHERE p.employee_id = vd.employee_id
            AND p.effective_from <= vd.work_date
            AND (p.effective_to IS NULL OR p.effective_to >= vd.work_date)
       )
   AND NOT EXISTS (
         SELECT 1 FROM proof p JOIN anc ON anc.dept_id = p.org_department_id
          WHERE p.employee_id = vd.employee_id
            AND p.effective_from <= vd.work_date
            AND (p.effective_to IS NULL OR p.effective_to >= vd.work_date)
            AND anc.anc_id = vd.department_id
       )
 GROUP BY vd.approval_id, vd.revision, dep.name, a.start_date, a.end_date, a.status, a.unlocked_at
 ORDER BY vd.approval_id`;

interface IRow {
  approval_id: string | number;
  revision: number;
  department_name: string | null;
  start_date: string;
  end_date: string;
  status: string;
  unlocked: boolean;
  foreign_days: number;
  foreign_days_with_hours: number;
  foreign_hours: number;
  employees: number;
}

async function main(): Promise<void> {
  const rows = await query<IRow>(FOREIGN_DAYS_SQL);

  if (rows.length === 0) {
    console.log('Чужих дней в последних редакциях нет — пересобирать нечего.');
    return;
  }

  console.log(`Подач с чужими днями: ${rows.length}\n`);
  for (const row of rows) {
    const skip = row.status !== 'approved' ? ' [ПРОПУСК: не approved]' : row.unlocked ? ' [ПРОПУСК: период открыт]' : '';
    console.log(
      `  #${row.approval_id} rev.${row.revision} ${row.department_name ?? '—'} `
      + `${row.start_date}–${row.end_date} · ${row.employees} сотр. · `
      + `${row.foreign_days} дн. (${row.foreign_days_with_hours} с часами, ${row.foreign_hours} ч)${skip}`,
    );
  }

  const totals = rows.reduce(
    (acc, row) => ({
      days: acc.days + row.foreign_days,
      hours: acc.hours + row.foreign_hours,
    }),
    { days: 0, hours: 0 },
  );
  console.log(`\nИтого: ${totals.days} чужих дней, ${Math.round(totals.hours * 100) / 100} ч`);

  // Пометку принимают только закрытые утверждённые подачи: открытая соберёт
  // правильную редакцию сама при закрытии.
  const markable = rows
    .filter(row => row.status === 'approved' && !row.unlocked)
    .map(row => Number(row.approval_id))
    .filter(id => ONLY == null || ONLY.has(id));

  if (ONLY != null) {
    const missing = [...ONLY].filter(id => !markable.includes(id));
    if (missing.length > 0) {
      console.log(`
--only: не найдены среди подлежащих пометке: ${missing.join(', ')}`);
    }
  }

  if (!APPLY) {
    console.log(`\nDry-run. К пометке готовы ${markable.length} подач. Запуск с --yes пометит их на пересборку.`);
    return;
  }

  await markVersionDirtyForOperatorRebuild(getPool(), markable);
  console.log(`\nПомечено на пересборку: ${markable.length}. Фоновый воркер разберёт их по 20 за тик (60 сек).`);
  console.log('Пока подача помечена, публичный API отвечает 409 TIMESHEET_REBUILD_PENDING — это штатное состояние.');
}

main()
  .catch(err => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
