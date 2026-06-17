/**
 * Одноразовая чистка: удаляет ВСЕ корректировки табеля, сделанные начальником участка
 * Кенгашевым У.А., за период 1–15 июня 2026, и только по двум бригадам:
 *   - бр.Жабаров Т.А.
 *   - бр.Шайманова Х.К.У.
 *
 * Контекст: до фикса гарда (commit 3f1e843b) правки со status='manual' обходили
 * ограничения роли (только-аномалии / лимит 3-в-месяц). Кенгашев наставил массу правок
 * по этим бригадам; их нужно снять, чтобы дни вернулись к расчёту по СКУД.
 *
 * ВАЖНО про скоуп сотрудников: берём сотрудников по ТЕКУЩЕЙ принадлежности
 * (employees.org_department_id = id этих двух бригад). Сотрудники, переведённые/уволенные
 * из этих бригад (сейчас в другом отделе / «Уволенные»), сюда НЕ попадут. Если нужно
 * включить и таких — добавить их id в EXTRA_EMPLOYEE_IDS ниже.
 *
 * Что удаляется: ВСЕ строки attendance_adjustments с created_by = Кенгашев,
 * work_date ∈ [2026-06-01; 2026-06-15], employee_id ∈ члены бригад — любой status/source_type
 * (manual, manual_object, work/absent/vacation и т.д.). Перед удалением строки чистятся
 * её вложения (document_links/documents) и осиротевшие объекты в R2.
 *
 * Идемпотентно: повторный запуск найдёт 0 строк.
 *
 * Запуск (из build-контекста на проде, где есть src+tsx и .env сайта):
 *   cd fot-server
 *   npx tsx scripts/delete-kengashev-june-corrections-jabarov-shaymanova.ts            # DRY-RUN
 *   npx tsx scripts/delete-kengashev-june-corrections-jabarov-shaymanova.ts --migrate  # ПРИМЕНИТЬ
 */
import { query, execute } from '../src/config/postgres.js';
import { purgeCorrectionAttachments } from '../src/services/correction-attachments.service.js';
import { r2Service } from '../src/services/r2.service.js';

const LOG = '[del-kengashev-may]';
const APPLY = process.argv.includes('--migrate') || process.argv.includes('migrate');

const KENGASHEV_NAME = 'Кенгашев Улмас Аллабердиевич';
const BRIGADE_NAMES = ['бр.Жабаров Т.А.', 'бр.Шайманова Х.К.У.'];
const DATE_FROM = '2026-06-01';
const DATE_TO = '2026-06-15';

/** Доп. сотрудники для включения в скоуп (переведённые/уволенные из этих бригад). Пусто по умолчанию. */
const EXTRA_EMPLOYEE_IDS: number[] = [];

interface ITargetRow {
  id: string;
  employee_id: number;
  full_name: string | null;
  work_date: string;
  status: string;
  source_type: string;
  hours_override: string | null;
}

const main = async (): Promise<void> => {
  console.log(`${LOG} режим: ${APPLY ? 'MIGRATE (удаление в БД)' : 'DRY-RUN (только план)'}`);

  // 1) Кенгашев — профиль и роль.
  const profiles = await query<{ id: string; full_name: string; role_code: string | null }>(
    `SELECT p.id, p.full_name, sr.code AS role_code
       FROM public.user_profiles p
       LEFT JOIN system_roles sr ON sr.id = p.system_role_id
      WHERE p.full_name = $1`,
    [KENGASHEV_NAME],
  );
  if (profiles.length !== 1) {
    throw new Error(`Ожидался ровно 1 профиль "${KENGASHEV_NAME}", найдено ${profiles.length}.`);
  }
  const createdBy = profiles[0].id;
  console.log(`${LOG} Кенгашев: ${profiles[0].full_name} (${createdBy}), роль=${profiles[0].role_code}`);

  // 2) Бригады — id по именам (ожидаем ровно 2).
  const brigades = await query<{ id: string; name: string }>(
    `SELECT id, name FROM org_departments WHERE name = ANY($1::text[])`,
    [BRIGADE_NAMES],
  );
  if (brigades.length !== BRIGADE_NAMES.length) {
    throw new Error(`Ожидалось ${BRIGADE_NAMES.length} бригад, найдено ${brigades.length}: ${JSON.stringify(brigades)}`);
  }
  const brigadeIds = brigades.map(b => b.id);
  brigades.forEach(b => console.log(`${LOG} бригада: ${b.name} (${b.id})`));

  // 3) Члены бригад по текущей принадлежности (+ доп. список).
  const memberRows = await query<{ id: number }>(
    `SELECT id FROM employees WHERE org_department_id = ANY($1::uuid[])`,
    [brigadeIds],
  );
  const memberIds = Array.from(new Set(memberRows.map(r => Number(r.id)).concat(EXTRA_EMPLOYEE_IDS)));
  console.log(`${LOG} сотрудников в скоупе: ${memberIds.length}`);
  if (memberIds.length === 0) {
    console.log(`${LOG} нет сотрудников — нечего удалять.`);
    return;
  }

  // 4) Целевые корректировки.
  const targets = await query<ITargetRow>(
    `SELECT a.id,
            a.employee_id,
            e.full_name,
            a.work_date::text AS work_date,
            a.status,
            a.source_type,
            a.hours_override::text AS hours_override
       FROM attendance_adjustments a
       LEFT JOIN employees e ON e.id = a.employee_id
      WHERE a.created_by = $1::uuid
        AND a.work_date >= $2::date
        AND a.work_date <= $3::date
        AND a.employee_id = ANY($4::bigint[])
      ORDER BY a.employee_id, a.work_date`,
    [createdBy, DATE_FROM, DATE_TO, memberIds],
  );

  console.log(`${LOG} к удалению: ${targets.length} строк, период ${DATE_FROM}..${DATE_TO}`);
  if (targets.length === 0) {
    console.log(`${LOG} нечего удалять (идемпотентно).`);
    return;
  }

  // Разбивка для аудита.
  const byKey = new Map<string, number>();
  for (const t of targets) {
    const k = `${t.status}/${t.source_type}`;
    byKey.set(k, (byKey.get(k) ?? 0) + 1);
  }
  console.log(`${LOG} разбивка status/source_type:`);
  for (const [k, n] of Array.from(byKey.entries()).sort()) console.log(`${LOG}   ${k}: ${n}`);
  console.log(`${LOG} сотрудников затронуто: ${new Set(targets.map(t => t.employee_id)).size}`);

  if (!APPLY) {
    console.log(`${LOG} DRY-RUN: БД не изменялась. Запусти с --migrate для удаления.`);
    return;
  }

  // 5) Чистим вложения каждой строки → собираем осиротевшие R2-ключи.
  const ids = targets.map(t => Number(t.id));
  const r2Keys: string[] = [];
  for (const id of ids) {
    try {
      const keys = await purgeCorrectionAttachments(id);
      r2Keys.push(...keys);
    } catch (e) {
      console.warn(`${LOG} вложения adj#${id}: ошибка чистки (продолжаем):`, e instanceof Error ? e.message : e);
    }
  }

  // 6) Удаляем сами корректировки одним запросом.
  await execute(`DELETE FROM attendance_adjustments WHERE id = ANY($1::bigint[])`, [ids]);
  console.log(`${LOG} удалено строк attendance_adjustments: ${ids.length}`);

  // 7) Удаляем осиротевшие объекты в R2 (best-effort).
  if (r2Keys.length > 0) {
    if (await r2Service.isEnabledAsync()) {
      const res = await Promise.allSettled(r2Keys.map(k => r2Service.deleteObject(k)));
      const ok = res.filter(r => r.status === 'fulfilled').length;
      console.log(`${LOG} R2: удалено ${ok}/${r2Keys.length} осиротевших объектов.`);
    } else {
      console.log(`${LOG} R2 выключен — осиротевшие ключи не удалены (${r2Keys.length}).`);
    }
  }

  console.log(`${LOG} ГОТОВО.`);
};

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`${LOG} фатальная ошибка:`, err instanceof Error ? err.message : err);
    process.exit(1);
  });
