/**
 * Одноразовая чистка: удаляет ЧАСОВЫЕ корректировки табеля, внесённые начальниками участков
 * (роль site_supervisor) по отделу «ЛИНИЯ-Общестрой» начиная с 16 июня 2026.
 *
 * Контекст: до фикса гарда (POSITIVE_TIME_STATUSES/guardsRestriction) начальники участков
 * дописывали рабочие часы (в т.ч. себе/прорабам, работа в выходные, работа на больничном) в
 * обход лимита=0. Эти правки нужно снять, чтобы дни вернулись к расчёту по СКУД.
 *
 * Фильтр (согласован):
 *   - отдел: employees.org_department_id = ЛИНИЯ-Общестрой;
 *   - автор: только роль site_supervisor (user_profiles.system_role_id);
 *   - статус: только часы — status IN ('work','manual') ИЛИ source_type = 'manual_object';
 *   - дата: work_date >= 2026-06-16 (по дню табеля);
 *   - только положительные часы: status='work' ИЛИ hours_override > 0
 *     (обнуления hours_override = 0 НЕ удаляются — за ролью сохранено право обнулять день).
 *
 * Что удаляется: строки attendance_adjustments под фильтр. Перед удалением чистятся вложения
 * (document_links/documents) и осиротевшие объекты в R2. Идемпотентно: повторный запуск → 0 строк.
 *
 * Страховка: на --migrate множество найденных id сверяется с --expected-ids (или с
 * DEFAULT_EXPECTED_IDS). При расхождении — abort, ничего не удаляется (защита от строк,
 * появившихся между DRY-RUN и запуском). Сверку можно отключить флагом --no-expect.
 *
 * Запуск (из build-контекста на проде, где есть src+tsx и .env сайта):
 *   cd fot-server
 *   npx tsx scripts/delete-line-obshchestroy-supervisor-hours-from-jun16.ts            # DRY-RUN
 *   npx tsx scripts/delete-line-obshchestroy-supervisor-hours-from-jun16.ts --migrate --expected-ids=46859,47291,47328,48343,48552,48700
 */
import { query, withTransaction } from '../src/config/postgres.js';
import { purgeCorrectionAttachments } from '../src/services/correction-attachments.service.js';
import { r2Service } from '../src/services/r2.service.js';

const LOG = '[del-line-obshchestroy-sup-hours]';
const APPLY = process.argv.includes('--migrate') || process.argv.includes('migrate');
const NO_EXPECT = process.argv.includes('--no-expect');

const DEPARTMENT_NAME = 'ЛИНИЯ-Общестрой';
const SUPERVISOR_ROLE_CODE = 'site_supervisor';
const DATE_FROM = '2026-06-16';

/** Ожидаемые id (из DRY-RUN на момент написания). Сверяются на --migrate, если --expected-ids не задан. */
const DEFAULT_EXPECTED_IDS: number[] = [46859, 47291, 47328, 48343, 48552, 48700];

/** Разбирает --expected-ids=1,2,3 из argv. Возвращает null, если флаг не передан. */
const parseExpectedIds = (): number[] | null => {
  const arg = process.argv.find(a => a.startsWith('--expected-ids='));
  if (!arg) return null;
  return arg
    .slice('--expected-ids='.length)
    .split(',')
    .map(s => Number(s.trim()))
    .filter(n => Number.isFinite(n));
};

interface ITargetRow {
  id: string;
  employee_id: number;
  full_name: string | null;
  position: string | null;
  work_date: string;
  status: string;
  source_type: string;
  hours_override: string | null;
  author: string | null;
}

const main = async (): Promise<void> => {
  console.log(`${LOG} режим: ${APPLY ? 'MIGRATE (удаление в БД)' : 'DRY-RUN (только план)'}`);

  // 1) Отдел ЛИНИЯ-Общестрой (ожидаем ровно 1).
  const depts = await query<{ id: string; name: string }>(
    `SELECT id, name FROM org_departments WHERE name = $1`,
    [DEPARTMENT_NAME],
  );
  if (depts.length !== 1) {
    throw new Error(`Ожидался ровно 1 отдел "${DEPARTMENT_NAME}", найдено ${depts.length}: ${JSON.stringify(depts)}`);
  }
  const deptId = depts[0].id;
  console.log(`${LOG} отдел: ${depts[0].name} (${deptId})`);

  // 2) Авторы — пользователи с ролью site_supervisor.
  const supervisors = await query<{ id: string }>(
    `SELECT p.id
       FROM public.user_profiles p
       JOIN system_roles sr ON sr.id = p.system_role_id
      WHERE sr.code = $1`,
    [SUPERVISOR_ROLE_CODE],
  );
  const supervisorIds = supervisors.map(s => s.id);
  console.log(`${LOG} начальников участков (site_supervisor): ${supervisorIds.length}`);
  if (supervisorIds.length === 0) {
    console.log(`${LOG} нет авторов-начальников — нечего удалять.`);
    return;
  }

  // 3) Целевые часовые корректировки по отделу.
  const targets = await query<ITargetRow>(
    `SELECT a.id,
            a.employee_id,
            e.full_name,
            pos.name AS position,
            a.work_date::text AS work_date,
            a.status,
            a.source_type,
            a.hours_override::text AS hours_override,
            up.full_name AS author
       FROM attendance_adjustments a
       JOIN employees e ON e.id = a.employee_id
       LEFT JOIN positions pos ON pos.id = e.position_id
       JOIN public.user_profiles up ON up.id = a.created_by
      WHERE e.org_department_id = $1::uuid
        AND a.created_by = ANY($2::uuid[])
        AND a.work_date >= $3::date
        AND (a.status IN ('work','manual') OR a.source_type = 'manual_object')
        AND (a.status = 'work' OR a.hours_override > 0)
      ORDER BY a.work_date, e.full_name`,
    [deptId, supervisorIds, DATE_FROM],
  );

  console.log(`${LOG} к удалению: ${targets.length} строк, отдел "${DEPARTMENT_NAME}", work_date >= ${DATE_FROM}`);
  if (targets.length === 0) {
    console.log(`${LOG} нечего удалять (идемпотентно).`);
    return;
  }

  // Полный список для сверки оператором.
  for (const t of targets) {
    console.log(
      `${LOG}   id=${t.id} ${t.work_date} ${t.status}/${t.source_type} ` +
      `hours=${t.hours_override ?? 'null'} | ${t.full_name ?? '?'} (${t.position ?? '—'}) | автор: ${t.author ?? '?'}`,
    );
  }
  console.log(`${LOG} сотрудников затронуто: ${new Set(targets.map(t => t.employee_id)).size}`);

  const ids = targets.map(t => Number(t.id)).sort((a, b) => a - b);

  if (!APPLY) {
    console.log(`${LOG} id: ${ids.join(',')}`);
    console.log(`${LOG} DRY-RUN: БД не изменялась. Запусти с --migrate (+ --expected-ids=...) для удаления.`);
    return;
  }

  // 4) Страховка: сверяем найденные id с ожидаемыми (если сверка не отключена).
  if (!NO_EXPECT) {
    const expected = (parseExpectedIds() ?? DEFAULT_EXPECTED_IDS).slice().sort((a, b) => a - b);
    const same = ids.length === expected.length && ids.every((v, i) => v === expected[i]);
    if (!same) {
      throw new Error(
        `Найденные id [${ids.join(',')}] не совпадают с ожидаемыми [${expected.join(',')}]. ` +
        `Сверь DRY-RUN и передай актуальный --expected-ids=... (или --no-expect, чтобы отключить сверку).`,
      );
    }
    console.log(`${LOG} сверка id с ожидаемыми пройдена (${ids.length}).`);
  } else {
    console.log(`${LOG} сверка id отключена (--no-expect).`);
  }

  // 5) Чистим вложения каждой строки → собираем осиротевшие R2-ключи (часовые правки обычно
  //    без файлов; шаг защитный). purgeCorrectionAttachments работает своей транзакцией.
  const r2Keys: string[] = [];
  for (const id of ids) {
    try {
      const keys = await purgeCorrectionAttachments(id);
      r2Keys.push(...keys);
    } catch (e) {
      console.warn(`${LOG} вложения adj#${id}: ошибка чистки (продолжаем):`, e instanceof Error ? e.message : e);
    }
  }

  // 6) Удаляем сами корректировки одной транзакцией.
  await withTransaction(async (client) => {
    await client.query(`DELETE FROM attendance_adjustments WHERE id = ANY($1::bigint[])`, [ids]);
  });
  console.log(`${LOG} удалено строк attendance_adjustments: ${ids.length}`);

  // 7) Удаляем осиротевшие объекты в R2 (best-effort, после commit).
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
