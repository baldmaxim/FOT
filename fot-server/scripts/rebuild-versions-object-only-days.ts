// Пересборка версий табеля, потерявших дни «только объектная корректировка».
//
// Контекст. Экспортный слой строил attendance без synthesizeObjectOnlyDays, поэтому день,
// заведённый ТОЛЬКО объектной правкой (нет прохода СКУД и нет day-level записи), не попадал
// в dataMap. Payload официальной версии строится из того же dataMap → такой день исчезал из
// закрытого табеля и из данных, которые забирает 1С. Объектная разбивка версии наследовала
// потерю: целевые часы дня она берёт из payload.days.
//
// Правка сборщика (timesheet-export.service: synthesizeObjectOnlyDays + отсечка по todayStr)
// чинит только БУДУЩИЕ редакции — новая редакция создаётся при «Утвердить»/«Закрыть».
// Уже созданные версии остаются без этих дней, пока их не пересоберут. Скрипт находит такие
// подачи и помечает операторской пометкой (markVersionDirtyForOperatorRebuild) — дальше их
// разбирает фоновый воркер timesheet-version-rebuild.service (батч 20, тик 60 сек).
//
// Пока подача помечена, публичный API отвечает 409 TIMESHEET_REBUILD_PENDING — это штатное
// состояние протокола, 1С повторит запрос позже. Останавливать обмен не требуется, но у
// затронутых подач вырастет revision: сторону 1С надо предупредить, чтобы перечитала их.
//
// ЗАПУСКАТЬ ТОЛЬКО ПОСЛЕ ДЕПЛОЯ исправленного бэкенда — иначе версия пересоберётся старым
// кодом и дыра останется.
//
// Usage:
//   npx tsx scripts/rebuild-versions-object-only-days.ts                  # dry-run: только список
//   npx tsx scripts/rebuild-versions-object-only-days.ts --yes --only=1574  # пилот на одной подаче
//   npx tsx scripts/rebuild-versions-object-only-days.ts --yes            # пометить все
//
// На проде запускать из /opt/fot-build (там лежат src и tsx).

import { query, getPool, closeDb } from '../src/config/postgres.js';
import { markVersionDirtyForOperatorRebuild } from '../src/services/timesheet-version-maintenance.js';

const APPLY = process.argv.includes('--yes');

const ONLY = (() => {
  const arg = process.argv.find(a => a.startsWith('--only='));
  if (!arg) return null;
  const ids = arg.slice('--only='.length).split(',').map(Number).filter(id => Number.isSafeInteger(id) && id > 0);
  return ids.length > 0 ? new Set(ids) : null;
})();

/**
 * Дни, которые держатся ТОЛЬКО на объектной корректировке и отсутствуют в payload
 * последней редакции версии.
 *
 * Критерий «object-only» повторяет attendance.service:
 *  - source_type = 'manual_object' и НЕ мигрированная из day-level (та трактуется как дневная);
 *  - суммарные часы за день > 0;
 *  - нет строки в skud_daily_summary на эту дату;
 *  - нет day-level корректировки (любой source_type, кроме manual_object).
 *
 * Берём только последнюю редакцию каждой подачи: пересобирать имеет смысл её.
 */
const LOST_DAYS_SQL = `
WITH obj_only AS (
  SELECT a.employee_id,
         a.work_date,
         SUM(a.hours_override) AS hours
    FROM attendance_adjustments a
   WHERE a.source_type = 'manual_object'
     AND COALESCE((a.metadata->>'migrated_from_day_level')::bool, false) = false
     AND NOT EXISTS (
           SELECT 1 FROM skud_daily_summary s
            WHERE s.employee_id = a.employee_id AND s.date = a.work_date
         )
     AND NOT EXISTS (
           SELECT 1 FROM attendance_adjustments d
            WHERE d.employee_id = a.employee_id AND d.work_date = a.work_date
              AND d.source_type <> 'manual_object'
         )
   GROUP BY a.employee_id, a.work_date
  HAVING SUM(a.hours_override) > 0
), latest_ver AS (
  SELECT DISTINCT ON (v.approval_id)
         v.approval_id, v.revision, v.payload, v.start_date, v.end_date
    FROM timesheet_versions v
   ORDER BY v.approval_id, v.revision DESC
), lost AS (
  SELECT lv.approval_id,
         lv.revision,
         o.employee_id,
         o.work_date,
         o.hours
    FROM latest_ver lv
    JOIN obj_only o
      ON o.work_date BETWEEN lv.start_date AND lv.end_date
    JOIN LATERAL (
      SELECT e AS emp
        FROM jsonb_array_elements(lv.payload::jsonb->'employees') e
       WHERE (e->'identity'->>'employee_id')::int = o.employee_id
    ) je ON true
   WHERE NOT (je.emp->'days') ? o.work_date::text
)
SELECT l.approval_id,
       l.revision,
       dep.name              AS department_name,
       a.start_date::text    AS start_date,
       a.end_date::text      AS end_date,
       a.status,
       (a.unlocked_at IS NOT NULL) AS unlocked,
       (a.version_dirty_at IS NOT NULL) AS already_dirty,
       count(*)::int              AS lost_days,
       count(DISTINCT l.employee_id)::int AS employees,
       ROUND(SUM(l.hours)::numeric, 2)    AS lost_hours,
       string_agg(
         DISTINCT e.full_name || ' (' || l.work_date::text || ')', '; '
         ORDER BY e.full_name || ' (' || l.work_date::text || ')'
       ) AS details
  FROM lost l
  JOIN timesheet_approvals a ON a.id = l.approval_id
  JOIN employees e           ON e.id = l.employee_id
  LEFT JOIN org_departments dep ON dep.id = a.department_id
 GROUP BY l.approval_id, l.revision, dep.name, a.start_date, a.end_date,
          a.status, a.unlocked_at, a.version_dirty_at
 ORDER BY l.approval_id`;

interface IRow {
  approval_id: string | number;
  revision: number;
  department_name: string | null;
  start_date: string;
  end_date: string;
  status: string;
  unlocked: boolean;
  already_dirty: boolean;
  lost_days: number;
  employees: number;
  lost_hours: string | number;
  details: string;
}

async function main(): Promise<void> {
  const rows = await query<IRow>(LOST_DAYS_SQL);

  if (rows.length === 0) {
    console.log('Потерянных object-only дней в последних редакциях нет — пересобирать нечего.');
    return;
  }

  console.log(`Подач с потерянными object-only днями: ${rows.length}\n`);
  for (const row of rows) {
    const skip = row.status !== 'approved'
      ? ' [ПРОПУСК: не approved]'
      : row.unlocked ? ' [ПРОПУСК: период открыт]'
        : row.already_dirty ? ' [уже помечена]' : '';
    console.log(
      `  #${row.approval_id} rev.${row.revision} ${row.department_name ?? '—'} `
      + `${row.start_date}–${row.end_date} · ${row.employees} сотр. · `
      + `${row.lost_days} дн. / ${row.lost_hours} ч${skip}`,
    );
    console.log(`      ${row.details}`);
  }

  const totals = rows.reduce(
    (acc, row) => ({
      days: acc.days + row.lost_days,
      hours: acc.hours + Number(row.lost_hours),
    }),
    { days: 0, hours: 0 },
  );
  console.log(`\nИтого: ${totals.days} потерянных дней, ${Math.round(totals.hours * 100) / 100} ч`);

  // Пометку принимают только закрытые утверждённые подачи: открытая соберёт
  // правильную редакцию сама при закрытии.
  const markable = rows
    .filter(row => row.status === 'approved' && !row.unlocked)
    .map(row => Number(row.approval_id))
    .filter(id => ONLY == null || ONLY.has(id));

  if (ONLY != null) {
    const missing = [...ONLY].filter(id => !markable.includes(id));
    if (missing.length > 0) {
      console.log(`\n--only: не найдены среди подлежащих пометке: ${missing.join(', ')}`);
    }
  }

  if (!APPLY) {
    console.log(`\nDry-run. К пометке готовы ${markable.length} подач. Запуск с --yes пометит их на пересборку.`);
    return;
  }

  if (markable.length === 0) {
    console.log('\nНечего помечать.');
    return;
  }

  await markVersionDirtyForOperatorRebuild(getPool(), markable);
  console.log(`\nПомечено на пересборку: ${markable.length}. Фоновый воркер разберёт их по 20 за тик (60 сек).`);
  console.log('Пока подача помечена, публичный API отвечает 409 TIMESHEET_REBUILD_PENDING — это штатное состояние.');
  console.log('После прогона проверить: version_dirty_at IS NULL и version_rebuild_last_error IS NULL у всех помеченных.');
}

main()
  .catch(err => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
