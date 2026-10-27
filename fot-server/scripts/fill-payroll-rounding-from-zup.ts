/**
 * Признак округления оклада (payroll_compensation_terms.proration_rounding, миграция 331) — по ЗУП за месяц.
 *
 * ЗУП округляет оклад за неполный месяц двумя способами: сумма до рубля (130 952,38 → 130 952) или дневная
 * ставка до копейки × дни (250 000 / 21 = 11 904,76 × 11 = 130 952,36). В ФОТ признака нет — скрипт находит,
 * у кого «По трудовому договору» в «Оплачено» за месяц совпало ТОЛЬКО со вторым способом (при норме 18–27 дн.,
 * одна строка условий на месяц), и ставит им daily_kopeck на условиях, действующих с этого месяца. Совпало с обоими
 * (сумма целая) или ни с одним — не трогает: признак по умолчанию ruble. Август 2026: 50 человек.
 *
 * Запуск: cd fot-server && npx tsx scripts/fill-payroll-rounding-from-zup.ts [--month=2026-08]          — список
 *         cd fot-server && npx tsx scripts/fill-payroll-rounding-from-zup.ts [--month=2026-08] --apply  — запись
 */
import { closeDb, query, withTransaction } from '../src/config/postgres.js';

const TAG = '[fill-payroll-rounding]';

const main = async (): Promise<void> => {
  const apply = process.argv.includes('--apply');
  const month = process.argv.find(arg => arg.startsWith('--month='))?.slice('--month='.length) ?? '2026-08';
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`--month=${month}: нужен месяц ГГГГ-ММ`);
  const monthStart = `${month}-01`;

  const rows = await query<{
    employee_id: number;
    full_name: string | null;
    department: string | null;
    salary: string;
    paid: string;
    days: number;
    norm: number;
  }>(
    `WITH terms AS (
       -- Одна строка условий на месяц (принят в середине — тоже): смена оклада внутри месяца сравнение путает.
       SELECT t.employee_id, max(t.monthly_salary + COALESCE(t.bonus_amount, 0)) AS s
         FROM payroll_compensation_terms t
        WHERE t.calc_type = 'salary'
          AND t.effective_from <= ($1::date + INTERVAL '1 month - 1 day')::date
          AND (t.effective_to IS NULL OR t.effective_to >= $1::date)
        GROUP BY t.employee_id
       HAVING count(*) = 1
     ), candidates AS (
       SELECT terms.employee_id, terms.s, p.amount, n.norm, round(p.amount / terms.s * n.norm) AS d
         FROM terms
         JOIN payroll_paid_amounts p
           ON p.employee_id = terms.employee_id AND p.month = $1::date AND p.item_code = 'contract'
        CROSS JOIN generate_series(18, 27) AS n(norm)
        WHERE p.amount <> terms.s
     ), matched AS (
       SELECT employee_id, s, amount,
              bool_or(amount = round(s / norm, 2) * d AND amount <> round(s * d / norm, 0)) AS daily,
              bool_or(amount = round(s * d / norm, 0) AND amount <> round(s / norm, 2) * d) AS ruble,
              (array_agg(d::int ORDER BY norm) FILTER (WHERE amount = round(s / norm, 2) * d))[1] AS days,
              (array_agg(norm ORDER BY norm) FILTER (WHERE amount = round(s / norm, 2) * d))[1] AS norm
         FROM candidates
        GROUP BY employee_id, s, amount
     )
     SELECT m.employee_id, e.full_name, d.name AS department, m.s::text AS salary, m.amount::text AS paid, m.days, m.norm
       FROM matched m
       JOIN employees e ON e.id = m.employee_id
       LEFT JOIN org_departments d ON d.id = e.org_department_id
      WHERE m.daily AND NOT m.ruble
      ORDER BY d.name, e.full_name`,
    [monthStart],
  );

  console.log(`${TAG} ${month}: дневная ставка до копейки — ${rows.length} чел.`);
  for (const row of rows) {
    console.log(`  ${row.employee_id}\t${row.full_name ?? ''}\t${row.department ?? ''}\t${row.salary} × ${row.days}/${row.norm} = ${row.paid}`);
  }
  if (!apply || rows.length === 0) return;

  const updated = await withTransaction(async client => (await client.query(
    `UPDATE payroll_compensation_terms
        SET proration_rounding = 'daily_kopeck', updated_at = now()
      WHERE employee_id = ANY($1::int[])
        AND (effective_to IS NULL OR effective_to >= $2::date)
        AND proration_rounding <> 'daily_kopeck'`,
    [rows.map(row => row.employee_id), monthStart],
  )).rowCount ?? 0);
  console.log(`${TAG} обновлено строк условий: ${updated}`);
};

main()
  .catch(error => {
    console.error(`${TAG} фатальная ошибка:`, error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
