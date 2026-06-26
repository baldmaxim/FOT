/**
 * Одноразовая чистка: удаляет ЧАСОВЫЕ корректировки табеля, внесённые начальниками участков
 * (роль site_supervisor) по рабочим бригадам и ИТР отдела «ЛИНИЯ-Общестрой» начиная с 16.06.2026.
 *
 * Контекст: до фикса гарда (POSITIVE_TIME_STATUSES/guardsRestriction) начальники участков
 * дописывали рабочие часы (себе/прорабам/рабочим, работа в выходные, работа на больничном) в
 * обход лимита=0. Эти правки нужно снять, чтобы дни вернулись к расчёту по СКУД.
 *
 * ОХВАТ ПО ОТДЕЛАМ (важно): рабочие сидят в бригадах «бр.*» — детях узла «Бригады», а
 * «ЛИНИЯ-Общестрой» — узел ИТР (рабочих там нет). Поэтому скоуп = поддеревья двух узлов
 * «Бригады» и «ЛИНИЯ-Общестрой» (оба — дети «Строительный участок»), развёрнутые через
 * public.get_descendant_department_ids. Узлы резолвим по имени через родителя, без хардкода UUID.
 *
 * Фильтр (согласован):
 *   - отдел: org_department_id сотрудника ∈ поддеревья(«Бригады», «ЛИНИЯ-Общестрой»);
 *   - автор: только роль site_supervisor (user_profiles.system_role_id);
 *   - статус: только часы — status IN ('work','manual') ИЛИ source_type = 'manual_object';
 *   - дата: work_date >= 2026-06-16 (по дню табеля);
 *   - только положительные часы: status='work' ИЛИ hours_override > 0
 *     (обнуления hours_override = 0 НЕ удаляются — за ролью сохранено право обнулять день).
 *
 * Перед удалением чистятся вложения (document_links/documents) и осиротевшие объекты в R2.
 * Идемпотентно: повторный запуск → 0 строк.
 *
 * Страховка: на --migrate обязательно указать ожидаемый результат свежего DRY-RUN — либо
 * --expect-count=N, либо --expected-ids=ID,ID,...; найденное сверяется, при расхождении abort
 * (защита от строк, появившихся/исчезнувших между DRY-RUN и запуском). --no-expect — осознанный обход.
 *
 * Запуск (из build-контекста на проде, где есть src+tsx и .env сайта):
 *   cd fot-server
 *   npx tsx scripts/delete-line-obshchestroy-supervisor-hours-from-jun16.ts                 # DRY-RUN
 *   npx tsx scripts/delete-line-obshchestroy-supervisor-hours-from-jun16.ts --migrate --expect-count=36
 *   npx tsx scripts/delete-line-obshchestroy-supervisor-hours-from-jun16.ts --migrate --expected-ids=46859,47291,...
 */
import { query, withTransaction } from '../src/config/postgres.js';
import { purgeCorrectionAttachments } from '../src/services/correction-attachments.service.js';
import { r2Service } from '../src/services/r2.service.js';

const LOG = '[del-line-obshchestroy-sup-hours]';
const APPLY = process.argv.includes('--migrate') || process.argv.includes('migrate');
const NO_EXPECT = process.argv.includes('--no-expect');

const PARENT_NAME = 'Строительный участок';
const ROOT_DEPT_NAMES = ['Бригады', 'ЛИНИЯ-Общестрой'];
const SUPERVISOR_ROLE_CODE = 'site_supervisor';
const DATE_FROM = '2026-06-16';

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

/** Разбирает --expect-count=N из argv. Возвращает null, если флаг не передан. */
const parseExpectCount = (): number | null => {
  const arg = process.argv.find(a => a.startsWith('--expect-count='));
  if (!arg) return null;
  const n = Number(arg.slice('--expect-count='.length).trim());
  return Number.isFinite(n) ? n : null;
};

interface ITargetRow {
  id: string;
  employee_id: number;
  full_name: string | null;
  position: string | null;
  dept: string | null;
  work_date: string;
  status: string;
  source_type: string;
  hours_override: string | null;
  author: string | null;
}

const main = async (): Promise<void> => {
  console.log(`${LOG} режим: ${APPLY ? 'MIGRATE (удаление в БД)' : 'DRY-RUN (только план)'}`);

  // 1) Корневые узлы охвата: дети «Строительный участок» с именами «Бригады» и «ЛИНИЯ-Общестрой».
  const roots = await query<{ id: string; name: string }>(
    `SELECT d.id, d.name
       FROM org_departments d
       JOIN org_departments par ON par.id = d.parent_id
      WHERE par.name = $1 AND d.name = ANY($2::text[])`,
    [PARENT_NAME, ROOT_DEPT_NAMES],
  );
  if (roots.length !== ROOT_DEPT_NAMES.length) {
    throw new Error(
      `Ожидалось ${ROOT_DEPT_NAMES.length} корневых узла (${ROOT_DEPT_NAMES.join(', ')}) под "${PARENT_NAME}", ` +
      `найдено ${roots.length}: ${JSON.stringify(roots)}`,
    );
  }
  const rootIds = roots.map(r => r.id);
  roots.forEach(r => console.log(`${LOG} корень охвата: ${r.name} (${r.id})`));

  // 2) Разворачиваем поддеревья в плоский список id отделов.
  const deptRows = await query<{ id: string }>(
    `SELECT id FROM public.get_descendant_department_ids($1::uuid[])`,
    [rootIds],
  );
  const deptIds = deptRows.map(r => r.id);
  console.log(`${LOG} отделов в охвате (с поддеревьями): ${deptIds.length}`);

  // 3) Авторы — пользователи с ролью site_supervisor.
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

  // 4) Целевые часовые корректировки по охвату.
  const targets = await query<ITargetRow>(
    `SELECT a.id,
            a.employee_id,
            e.full_name,
            pos.name AS position,
            d.name AS dept,
            a.work_date::text AS work_date,
            a.status,
            a.source_type,
            a.hours_override::text AS hours_override,
            up.full_name AS author
       FROM attendance_adjustments a
       JOIN employees e ON e.id = a.employee_id
       LEFT JOIN org_departments d ON d.id = e.org_department_id
       LEFT JOIN positions pos ON pos.id = e.position_id
       JOIN public.user_profiles up ON up.id = a.created_by
      WHERE e.org_department_id = ANY($1::uuid[])
        AND a.created_by = ANY($2::uuid[])
        AND a.work_date >= $3::date
        AND (a.status IN ('work','manual') OR a.source_type = 'manual_object')
        AND (a.status = 'work' OR a.hours_override > 0)
      ORDER BY d.name, a.work_date, e.full_name`,
    [deptIds, supervisorIds, DATE_FROM],
  );

  console.log(`${LOG} к удалению: ${targets.length} строк, охват «${ROOT_DEPT_NAMES.join(' + ')}», work_date >= ${DATE_FROM}`);
  if (targets.length === 0) {
    console.log(`${LOG} нечего удалять (идемпотентно).`);
    return;
  }

  // Полный список для сверки оператором.
  for (const t of targets) {
    console.log(
      `${LOG}   id=${t.id} ${t.work_date} ${t.status}/${t.source_type} ` +
      `hours=${t.hours_override ?? 'null'} | ${t.full_name ?? '?'} (${t.position ?? '—'}) ` +
      `| отдел: ${t.dept ?? '—'} | автор: ${t.author ?? '?'}`,
    );
  }
  console.log(`${LOG} сотрудников затронуто: ${new Set(targets.map(t => t.employee_id)).size}`);

  const ids = targets.map(t => Number(t.id)).sort((a, b) => a - b);

  if (!APPLY) {
    console.log(`${LOG} id: ${ids.join(',')}`);
    console.log(`${LOG} count: ${ids.length}`);
    console.log(`${LOG} DRY-RUN: БД не изменялась. Для удаления: --migrate --expect-count=${ids.length} (или --expected-ids=...).`);
    return;
  }

  // 5) Страховка: сверяем найденное с ожиданием оператора (число или точное множество id).
  if (!NO_EXPECT) {
    const expectedIds = parseExpectedIds();
    const expectCount = parseExpectCount();
    if (expectedIds === null && expectCount === null) {
      throw new Error(
        'Для --migrate укажи ожидаемый результат свежего DRY-RUN: --expect-count=N или ' +
        '--expected-ids=ID,ID,... (или --no-expect для осознанного обхода сверки).',
      );
    }
    if (expectedIds !== null) {
      const exp = expectedIds.slice().sort((a, b) => a - b);
      const same = ids.length === exp.length && ids.every((v, i) => v === exp[i]);
      if (!same) {
        throw new Error(
          `Найденные id [${ids.join(',')}] не совпадают с --expected-ids [${exp.join(',')}]. ` +
          'Сверь свежий DRY-RUN.',
        );
      }
      console.log(`${LOG} сверка по --expected-ids пройдена (${ids.length}).`);
    }
    if (expectCount !== null && expectCount !== ids.length) {
      throw new Error(
        `Найдено ${ids.length} строк, ожидалось --expect-count=${expectCount}. Сверь свежий DRY-RUN.`,
      );
    }
    if (expectCount !== null) console.log(`${LOG} сверка по --expect-count пройдена (${ids.length}).`);
  } else {
    console.log(`${LOG} сверка отключена (--no-expect).`);
  }

  // 6) Чистим вложения каждой строки → собираем осиротевшие R2-ключи (часовые правки обычно
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

  // 7) Удаляем сами корректировки одной транзакцией.
  await withTransaction(async (client) => {
    await client.query(`DELETE FROM attendance_adjustments WHERE id = ANY($1::bigint[])`, [ids]);
  });
  console.log(`${LOG} удалено строк attendance_adjustments: ${ids.length}`);

  // 8) Удаляем осиротевшие объекты в R2 (best-effort, после commit).
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
