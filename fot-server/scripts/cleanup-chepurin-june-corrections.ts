/**
 * Одноразовая очистка: удалить корректировки табеля Чепурина С.Р. ТОЛЬКО за июнь 2026.
 *
 * Контекст (read-only диагностика прод-БД):
 *   employee_id = 6137 «Чепурин Сергей Романович». За июнь у него 16 корректировок
 *   attendance_adjustments: source_type='manual_object' (ручные часы по объекту
 *   «ЖК Дом 56»), status='manual', approval_status='auto_approved', автор и редактор —
 *   он сам, согласующего нет. metadata содержит только object_id/object_name —
 *   НИ вложений, НИ ссылок на R2, НИ внешних FK на attendance_adjustments во всей
 *   схеме (проверено). Удаление = просто строки, без «сирот».
 *
 * Безопасность (несколько независимых защит):
 *   1) Жёсткая привязка к employee_id = 6137 И сверка ФИО = 'Чепурин Сергей Романович'.
 *   2) Диапазон строго work_date ∈ [2026-06-01 .. 2026-06-30].
 *   3) Разрешён к удалению только source_type ∈ ALLOWED_SOURCE_TYPES (manual_object).
 *      Любая строка вне списка → СТОП с распечаткой (ничего не удаляется).
 *   4) Предохранитель MAX_DELETE — если под удаление попадает больше — СТОП.
 *   5) Удаление в транзакции по явному списку id (собран в той же транзакции),
 *      DELETE дублирует guard employee_id=6137; число удалённых обязано совпасть
 *      с числом отобранных, иначе ROLLBACK.
 *
 * Двухэтапный запуск (из build-контекста на проде: src+tsx, .env сайта):
 *   cd fot-server
 *   npx tsx scripts/cleanup-chepurin-june-corrections.ts          # ЭТАП 1: проверка (dry-run)
 *   npx tsx scripts/cleanup-chepurin-june-corrections.ts --apply  # ЭТАП 2: удаление
 */
import { query, withTransaction } from '../src/config/postgres.js';

const EMP_ID = 6137;
const EXPECTED_NAME = 'Чепурин Сергей Романович';
const MONTH_START = '2026-06-01';
const MONTH_END = '2026-06-30';
const ALLOWED_SOURCE_TYPES = new Set<string>(['manual_object']);
const MAX_DELETE = 40; // предохранитель: реально ожидаем 16

const APPLY = process.argv.includes('--apply') || process.argv.includes('--migrate');
const LOG = '[cleanup-chepurin-june]';

interface IRow {
  id: string;
  employee_id: number;
  full_name: string;
  work_date: string;
  status: string;
  source_type: string;
  approval_status: string;
  hours_override: string | null;
}

const SELECT_TARGETS = `
  SELECT a.id::text AS id,
         a.employee_id,
         e.full_name,
         a.work_date::text AS work_date,
         a.status,
         a.source_type,
         a.approval_status,
         a.hours_override::text AS hours_override
    FROM attendance_adjustments a
    JOIN employees e ON e.id = a.employee_id
   WHERE a.employee_id = $1
     AND a.work_date >= $2::date AND a.work_date <= $3::date
   ORDER BY a.work_date, a.id`;

const main = async (): Promise<void> => {
  console.log(`${LOG} режим: ${APPLY ? 'APPLY (удаление в БД)' : 'DRY-RUN (только проверка)'}`);

  // Guard 1: сотрудник существует и ФИО совпадает.
  const emp = await query<{ full_name: string; employment_status: string }>(
    `SELECT full_name, employment_status FROM employees WHERE id = $1`,
    [EMP_ID],
  );
  if (emp.length === 0) {
    console.error(`${LOG} СТОП: сотрудник ID ${EMP_ID} не найден.`);
    process.exit(1);
  }
  if (emp[0].full_name !== EXPECTED_NAME) {
    console.error(
      `${LOG} СТОП: ФИО не совпало. Ожидали «${EXPECTED_NAME}», в БД «${emp[0].full_name}». Удаление отменено.`,
    );
    process.exit(1);
  }
  console.log(`${LOG} сотрудник OK: #${EMP_ID} ${emp[0].full_name} (status=${emp[0].employment_status})`);

  // Отбор июньских корректировок.
  const rows = await query<IRow>(SELECT_TARGETS, [EMP_ID, MONTH_START, MONTH_END]);
  console.log(`${LOG} найдено корректировок за июнь: ${rows.length}`);
  for (const r of rows) {
    console.log(
      `${LOG}   id=${r.id} | ${r.work_date} | ${r.status}/${r.source_type} | `
      + `${r.approval_status} | hours=${r.hours_override ?? 'NULL'}`,
    );
  }

  if (rows.length === 0) {
    console.log(`${LOG} нечего удалять — выход.`);
    process.exit(0);
  }

  // Guard 2: все строки принадлежат именно ему.
  const foreign = rows.filter(r => r.employee_id !== EMP_ID || r.full_name !== EXPECTED_NAME);
  if (foreign.length > 0) {
    console.error(`${LOG} СТОП: среди отобранных есть чужие строки (${foreign.length}). Отмена.`);
    process.exit(1);
  }

  // Guard 3: только разрешённые source_type.
  const disallowed = rows.filter(r => !ALLOWED_SOURCE_TYPES.has(r.source_type));
  if (disallowed.length > 0) {
    console.error(
      `${LOG} СТОП: найдены строки с непредусмотренным source_type `
      + `(${Array.from(new Set(disallowed.map(r => r.source_type))).join(', ')}). `
      + `Они могут быть связаны с заявками/файлами — удаление отменено, проверь вручную.`,
    );
    disallowed.forEach(r => console.error(`${LOG}     спорная: id=${r.id} ${r.work_date} ${r.source_type}`));
    process.exit(1);
  }

  // Guard 4: предохранитель по количеству.
  if (rows.length > MAX_DELETE) {
    console.error(`${LOG} СТОП: под удаление ${rows.length} > лимита ${MAX_DELETE}. Отмена для безопасности.`);
    process.exit(1);
  }

  const ids = rows.map(r => Number(r.id));
  const totalHours = rows.reduce((s, r) => s + Number(r.hours_override ?? 0), 0);
  console.log(`${LOG} к удалению: ${ids.length} строк, суммарно часов = ${totalHours}`);
  console.log(`${LOG} id: [${ids.join(', ')}]`);

  if (!APPLY) {
    console.log(`${LOG} DRY-RUN: БД не изменялась. Для удаления запусти с флагом --apply`);
    process.exit(0);
  }

  // ЭТАП 2: удаление в транзакции по явному списку id с повторной проверкой.
  await withTransaction(async (client) => {
    const recheck = await client.query<IRow>(
      `${SELECT_TARGETS} FOR UPDATE`,
      [EMP_ID, MONTH_START, MONTH_END],
    );
    const recheckIds = recheck.rows.map(r => Number(r.id)).sort((a, b) => a - b);
    const wantIds = [...ids].sort((a, b) => a - b);
    if (
      recheckIds.length !== wantIds.length
      || recheckIds.some((v, i) => v !== wantIds[i])
      || recheck.rows.some(r => r.employee_id !== EMP_ID || !ALLOWED_SOURCE_TYPES.has(r.source_type))
    ) {
      throw new Error('набор строк изменился между проверкой и удалением — ROLLBACK');
    }

    const del = await client.query<{ id: string }>(
      `DELETE FROM attendance_adjustments
        WHERE id = ANY($1::bigint[])
          AND employee_id = $2
          AND source_type = ANY($3::text[])
          AND work_date >= $4::date AND work_date <= $5::date
        RETURNING id::text AS id`,
      [recheckIds, EMP_ID, Array.from(ALLOWED_SOURCE_TYPES), MONTH_START, MONTH_END],
    );
    if (del.rowCount !== recheckIds.length) {
      throw new Error(
        `удалено ${del.rowCount}, ожидалось ${recheckIds.length} — несоответствие, ROLLBACK`,
      );
    }
    console.log(`${LOG} удалено строк: ${del.rowCount}`);
  });

  // Контроль после применения: должно остаться 0.
  const after = await query<{ cnt: string }>(
    `SELECT count(*)::text AS cnt FROM attendance_adjustments
      WHERE employee_id = $1 AND work_date >= $2::date AND work_date <= $3::date`,
    [EMP_ID, MONTH_START, MONTH_END],
  );
  console.log(`${LOG} ПРИМЕНЕНО. Осталось июньских корректировок у #${EMP_ID}: ${after[0].cnt} (ожидаем 0)`);
};

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`${LOG} фатальная ошибка:`, err instanceof Error ? err.message : err);
    process.exit(1);
  });
