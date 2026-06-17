/**
 * Диагностика (read-only): дубли файлов-вложений корректировок за период.
 * Один файл массовой корректировки до фикса прикреплялся отдельным документом на КАЖДЫЙ
 * день → в модалке вложений видно N одинаковых строк «Корректировка».
 *
 * Группировка по (employee_id, file_name, file_size, mime_type, uploaded_by).
 * Период по умолчанию — первая половина июня 2026 (FROM/TO через env).
 *
 * Запуск: npx tsx scripts/list-duplicate-correction-attachments.ts
 *         FROM=2026-06-01 TO=2026-06-15 npx tsx scripts/list-duplicate-correction-attachments.ts
 */
import { query } from '../src/config/postgres.js';

const FROM = process.env.FROM ?? '2026-06-01';
const TO = process.env.TO ?? '2026-06-15';

async function main(): Promise<void> {
  console.log(`🔍 Дубли вложений корректировок за ${FROM} … ${TO}\n`);

  const rows = await query<{
    employee: string;
    department: string | null;
    file_name: string;
    doc_count: number | string;
    date_from: string;
    date_to: string;
    uploaded_by: string | null;
  }>(
    `WITH corr_docs AS (
       SELECT d.id AS document_id, d.employee_id, d.file_name, d.file_size, d.mime_type,
              d.uploaded_by, aa.work_date
         FROM documents d
         JOIN document_links dl
           ON dl.document_id = d.id
          AND dl.entity_type = 'attendance_adjustment'
          AND dl.purpose = 'timesheet_correction'
         JOIN attendance_adjustments aa ON aa.id = dl.entity_id::int
        WHERE d.category = 'timesheet_correction'
          AND d.leave_request_id IS NULL
          AND aa.work_date >= $1::date AND aa.work_date <= $2::date
     ),
     grp AS (
       SELECT employee_id, file_name, file_size, mime_type, uploaded_by,
              COUNT(*) AS doc_count,
              MIN(work_date) AS date_from, MAX(work_date) AS date_to
         FROM corr_docs
        GROUP BY employee_id, file_name, file_size, mime_type, uploaded_by
       HAVING COUNT(*) > 1
     )
     SELECT e.full_name AS employee,
            od.name AS department,
            g.file_name,
            g.doc_count,
            to_char(g.date_from,'DD.MM') AS date_from,
            to_char(g.date_to,'DD.MM') AS date_to,
            up.full_name AS uploaded_by
       FROM grp g
       JOIN employees e ON e.id = g.employee_id
       LEFT JOIN org_departments od ON od.id = e.org_department_id
       LEFT JOIN user_profiles up ON up.id = g.uploaded_by
      ORDER BY od.name NULLS LAST, e.full_name`,
    [FROM, TO],
  );

  if (rows.length === 0) {
    console.log('✅ Дублей не найдено');
    return;
  }

  let total = 0;
  for (const r of rows) {
    total += Number(r.doc_count);
    console.log(
      `• ${r.employee} [${r.department ?? '—'}] — «${r.file_name}» ×${r.doc_count} `
      + `(${r.date_from}–${r.date_to}), прикрепил: ${r.uploaded_by ?? '—'}`,
    );
  }
  console.log(`\n📊 Наборов: ${rows.length}; всего дубль-документов: ${total}`);
}

main()
  .catch(err => { console.error('❌ Ошибка:', err); process.exit(1); })
  .then(() => process.exit(0));
