/**
 * Денежные формулы премии — на НАСТОЯЩЕМ PostgreSQL.
 *
 * Мок постгреса проверить их не может: интерполяция, решётка дней, приоритет статусов и
 * округление numeric живут внутри SQL, и подменённый ответ драйвера показал бы ровно то,
 * что ему подложили. Поэтому здесь берётся живая БД — но ТОЛЬКО SELECT: оба запроса
 * чистые, таблиц не читают, вход приходит параметрами. Годится любой PostgreSQL, включая
 * read-only реплику прода.
 *
 *   OBJECT_KPI_SQL_TEST_URL=postgres://…   (обязательно, иначе набор пропускается)
 *   OBJECT_KPI_SQL_TEST_CA=/path/ca.pem    (если сервер требует TLS с проверкой CA)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';

import { PREMIUM_MATH_SQL, PREMIUM_ASSIGNMENT_DAYS_SQL } from './object-kpi-premium.service.js';

const CONNECTION = process.env.OBJECT_KPI_SQL_TEST_URL;
const SCALE_VERSION = '11111111-1111-1111-1111-111111111111';
const OBJECT_A = '22222222-2222-2222-2222-222222222222';
const OBJECT_B = '33333333-3333-3333-3333-333333333333';

const POINTS = [
  ['80', '0.00'], ['85', '0.25'], ['90', '0.50'], ['95', '0.80'],
  ['100', '1.00'], ['105', '1.25'], ['110', '1.50'],
].map(([completion_pct, coefficient]) => ({ version_id: SCALE_VERSION, completion_pct, coefficient }));

interface MonthInput {
  period_month: string;
  any_days: number;
  eligible_days: number;
  days_in_month: number;
  has_incomplete?: boolean;
  scale_version_id?: string | null;
  base_amount?: string | null;
  salary?: string | null;
}

interface ShareInput {
  period_month: string;
  plan_exact: string;
  fact_exact: string;
}

// Без строки подключения набор целиком пропускается — обычный прогон npm run test
// не должен зависеть от доступности БД.
const suite = CONNECTION ? describe : describe.skip;

suite('премия KPI — формулы в SQL', () => {
  let pool: Pool;

  beforeAll(() => {
    const ca = process.env.OBJECT_KPI_SQL_TEST_CA;
    pool = new Pool({
      connectionString: CONNECTION,
      ssl: ca ? { ca: readFileSync(ca, 'utf8'), rejectUnauthorized: true } : undefined,
      max: 2,
    });
  });

  afterAll(async () => {
    await pool?.end();
  });

  const math = async (months: MonthInput[], shares: ShareInput[]) => {
    const meta = months.map((month) => ({
      has_incomplete: false,
      scale_version_id: SCALE_VERSION,
      base_amount: '200000.00',
      salary: null,
      ...month,
    }));
    const result = await pool.query(PREMIUM_MATH_SQL, [
      JSON.stringify(meta),
      JSON.stringify(shares),
      JSON.stringify(POINTS),
    ]);
    return result.rows;
  };

  const fullMonth = (period_month: string, days: number): MonthInput =>
    ({ period_month, any_days: days, eligible_days: days, days_in_month: days });

  it('примеры приказа: 100 % → 200 000, 107 % → 270 000, 95 % → 160 000, ≥110 % → 300 000', async () => {
    const rows = await math(
      [
        fullMonth('2026-08-01', 31),
        fullMonth('2026-09-01', 30),
        fullMonth('2026-10-01', 31),
        fullMonth('2026-11-01', 30),
      ],
      [
        { period_month: '2026-08-01', plan_exact: '100', fact_exact: '100' },
        { period_month: '2026-09-01', plan_exact: '100000000', fact_exact: '107000000' },
        { period_month: '2026-10-01', plan_exact: '100', fact_exact: '95' },
        { period_month: '2026-11-01', plan_exact: '100', fact_exact: '120' },
      ],
    );

    expect(rows.map((r) => [r.completion_pct, r.coefficient, r.premium_amount])).toEqual([
      ['100.00', '1.00', '200000'],
      ['107.00', '1.35', '270000'],
      ['95.00', '0.80', '160000'],
      ['120.00', '1.50', '300000'],
    ]);
  });

  it('точное попадание в точку шкалы берёт её коэффициент, а не делит на ноль', async () => {
    const rows = await math(
      [fullMonth('2026-08-01', 31), fullMonth('2026-09-01', 30), fullMonth('2026-10-01', 31)],
      [
        { period_month: '2026-08-01', plan_exact: '100', fact_exact: '90' },
        { period_month: '2026-09-01', plan_exact: '100', fact_exact: '105' },
        { period_month: '2026-10-01', plan_exact: '100', fact_exact: '110' },
      ],
    );

    expect(rows.map((r) => r.coefficient)).toEqual(['0.50', '1.25', '1.50']);
  });

  it('ниже минимальной точки коэффициент 0, премия 0 — включая отрицательный факт', async () => {
    const rows = await math(
      [fullMonth('2026-08-01', 31), fullMonth('2026-09-01', 30)],
      [
        { period_month: '2026-08-01', plan_exact: '10000', fact_exact: '7999' },
        // Снятие объёма заказчиком (п. 3.3) — факт может стать отрицательным.
        { period_month: '2026-09-01', plan_exact: '100', fact_exact: '-10' },
      ],
    );

    expect(rows.map((r) => [r.completion_pct, r.coefficient, r.premium_amount])).toEqual([
      ['79.99', '0.00', '0'],
      ['-10.00', '0.00', '0'],
    ]);
  });

  it('неполный месяц закрепления режет базу по дням (п. 4.6)', async () => {
    const rows = await math(
      [
        // Закрепление с 14 августа: 18 дней из 31.
        { period_month: '2026-08-01', any_days: 18, eligible_days: 18, days_in_month: 31 },
        { period_month: '2026-02-01', any_days: 14, eligible_days: 14, days_in_month: 28 },
      ],
      [
        { period_month: '2026-08-01', plan_exact: '100', fact_exact: '107' },
        { period_month: '2026-02-01', plan_exact: '100', fact_exact: '100' },
      ],
    );

    expect(rows.find((r) => r.period_month === '2026-08-01')).toMatchObject({
      base_prorated: '116129.03',
      coefficient: '1.35',
      premium_amount: '156774',
    });
    expect(rows.find((r) => r.period_month === '2026-02-01')).toMatchObject({
      base_prorated: '100000.00',
      premium_amount: '100000',
    });
  });

  it('доли двух руководителей в сумме дают план объекта (допуск копейки)', async () => {
    // Объект с планом 100 000 000,00 делится 17/31 и 14/31 — точное деление невозможно,
    // поэтому проверяется допуск, а не побитовое равенство.
    const planA = '100000000.00';
    const share = (days: number) => (100000000 * days / 31).toFixed(10);

    const rows = await math(
      [fullMonth('2026-08-01', 31)],
      [
        { period_month: '2026-08-01', plan_exact: share(17), fact_exact: share(17) },
        { period_month: '2026-08-01', plan_exact: share(14), fact_exact: share(14) },
      ],
    );

    expect(Math.abs(Number(rows[0].total_plan) - Number(planA))).toBeLessThanOrEqual(0.01);
    expect(rows[0].completion_pct).toBe('100.00');
  });

  it('приоритет статусов: no_scale → not_assigned → data_incomplete → no_plan', async () => {
    const rows = await math(
      [
        { ...fullMonth('2026-05-01', 31), scale_version_id: null, base_amount: null },
        { period_month: '2026-06-01', any_days: 0, eligible_days: 0, days_in_month: 30 },
        { ...fullMonth('2026-07-01', 31), has_incomplete: true },
        fullMonth('2026-08-01', 31),
        fullMonth('2026-09-01', 30),
      ],
      [
        { period_month: '2026-05-01', plan_exact: '100', fact_exact: '100' },
        { period_month: '2026-06-01', plan_exact: '100', fact_exact: '100' },
        { period_month: '2026-07-01', plan_exact: '100', fact_exact: '100' },
        { period_month: '2026-08-01', plan_exact: '0', fact_exact: '0' },
        { period_month: '2026-09-01', plan_exact: '100', fact_exact: '100' },
      ],
    );

    expect(rows.map((r) => r.status)).toEqual([
      'no_scale', 'not_assigned', 'data_incomplete', 'no_plan', 'calculated',
    ]);
    // Неполный портфель премию не получает — частичная сумма выглядела бы полной.
    expect(rows[2].premium_amount).toBeNull();
    expect(rows[3].premium_amount).toBeNull();
  });

  it('закреплён, но плана нет: no_plan, а не not_assigned', async () => {
    const rows = await math(
      [{ period_month: '2026-08-01', any_days: 31, eligible_days: 0, days_in_month: 31 }],
      [],
    );

    expect(rows[0].status).toBe('no_plan');
    expect(rows[0].any_assignment_days).toBe(31);
    expect(rows[0].eligible_assignment_days).toBe(0);
  });

  it('итоги периода считают только состоявшиеся месяцы', async () => {
    const rows = await math(
      [
        fullMonth('2026-08-01', 31),
        { period_month: '2026-09-01', any_days: 0, eligible_days: 0, days_in_month: 30 },
      ],
      [
        { period_month: '2026-08-01', plan_exact: '100', fact_exact: '107' },
        // Месяц без закрепления: строки быть не должно, но даже если она придёт — не в итог.
        { period_month: '2026-09-01', plan_exact: '1000000', fact_exact: '0' },
      ],
    );

    expect(rows[0].period_total_plan).toBe('100.00');
    expect(rows[0].period_completion_pct).toBe('107.00');
    expect(rows[0].period_total_premium).toBe('270000');
  });

  const days = async (
    monthFrom: string,
    monthTo: string,
    assignments: Array<{
      skud_object_id: string;
      valid_from: string;
      valid_to: string | null;
      salary_amount?: string | null;
    }>,
    eligible: Array<{ period_month: string; skud_object_id: string }>,
  ) => {
    const result = await pool.query(PREMIUM_ASSIGNMENT_DAYS_SQL, [
      monthFrom,
      monthTo,
      JSON.stringify(assignments),
      JSON.stringify(eligible),
    ]);
    return result.rows;
  };

  it('дни закрепления: с 14-го числа — 18 дней августа и все 30 сентября', async () => {
    const rows = await days(
      '2026-08-01',
      '2026-09-01',
      [{ skud_object_id: OBJECT_A, valid_from: '2026-08-14', valid_to: null }],
      [
        { period_month: '2026-08-01', skud_object_id: OBJECT_A },
        { period_month: '2026-09-01', skud_object_id: OBJECT_A },
      ],
    );

    expect(rows).toEqual([
      { period_month: '2026-08-01', days_in_month: 31, any_assignment_days: 18, eligible_assignment_days: 18, salary_prorated: null },
      { period_month: '2026-09-01', days_in_month: 30, any_assignment_days: 30, eligible_assignment_days: 30, salary_prorated: null },
    ]);
  });

  it('дни по объекту без плана считаются в any, но не в eligible', async () => {
    const rows = await days(
      '2026-08-01',
      '2026-08-01',
      [
        { skud_object_id: OBJECT_A, valid_from: '2026-08-01', valid_to: '2026-08-10' },
        { skud_object_id: OBJECT_B, valid_from: '2026-08-01', valid_to: null },
      ],
      [{ period_month: '2026-08-01', skud_object_id: OBJECT_A }],
    );

    expect(rows[0]).toEqual({
      period_month: '2026-08-01',
      days_in_month: 31,
      any_assignment_days: 31,
      eligible_assignment_days: 10,
      // Оклад ни в одном закреплении не задан: null, а не ноль — интерфейс по нему
      // отличает «зарплата не ведётся» от «зарплата 0».
      salary_prorated: null,
    });
  });

  it('оклад целиком за полный месяц и пропорционально за неполный', async () => {
    const rows = await days(
      '2026-08-01',
      '2026-09-01',
      [{ skud_object_id: OBJECT_A, valid_from: '2026-08-14', valid_to: null, salary_amount: '310000.00' }],
      [
        { period_month: '2026-08-01', skud_object_id: OBJECT_A },
        { period_month: '2026-09-01', skud_object_id: OBJECT_A },
      ],
    );

    // 18 дней из 31: 310 000 × 18 / 31.
    expect(rows[0].salary_prorated).toBe('180000.00');
    expect(rows[1].salary_prorated).toBe('310000.00');
  });

  it('передача объекта внутри месяца: два закрепления дают в сумме один оклад', async () => {
    const rows = await days(
      '2026-08-01',
      '2026-08-01',
      [
        { skud_object_id: OBJECT_A, valid_from: '2026-08-01', valid_to: '2026-08-15', salary_amount: '310000.00' },
        { skud_object_id: OBJECT_B, valid_from: '2026-08-16', valid_to: null, salary_amount: '310000.00' },
      ],
      [{ period_month: '2026-08-01', skud_object_id: OBJECT_A }],
    );

    expect(rows[0].salary_prorated).toBe('310000.00');
  });

  it('оклад начисляется и в месяце без плана: премию гасит статус, зарплату — нет', async () => {
    const rows = await math(
      [{ period_month: '2026-08-01', any_days: 31, eligible_days: 0, days_in_month: 31, salary: '310000.00' }],
      [],
    );

    expect(rows[0].status).toBe('no_plan');
    expect(rows[0].premium_amount).toBeNull();
    expect(rows[0].salary_amount).toBe('310000.00');
    expect(rows[0].total_amount).toBe('310000.00');
  });

  it('итого = премия + оклад, копейки оклада не теряются', async () => {
    const rows = await math(
      [{ ...fullMonth('2026-08-01', 31), salary: '310000.55' }],
      [{ period_month: '2026-08-01', plan_exact: '100', fact_exact: '100' }],
    );

    expect(rows[0].premium_amount).toBe('200000');
    expect(rows[0].total_amount).toBe('510000.55');
  });

  it('без оклада итого равно премии, а оклад приходит null', async () => {
    const rows = await math(
      [fullMonth('2026-08-01', 31)],
      [{ period_month: '2026-08-01', plan_exact: '100', fact_exact: '100' }],
    );

    expect(rows[0].salary_amount).toBeNull();
    expect(rows[0].total_amount).toBe('200000.00');
  });

  it('февраль високосного года даёт 29 дней', async () => {
    const rows = await days(
      '2028-02-01',
      '2028-02-01',
      [{ skud_object_id: OBJECT_A, valid_from: '2028-02-01', valid_to: null }],
      [{ period_month: '2028-02-01', skud_object_id: OBJECT_A }],
    );

    expect(rows[0].days_in_month).toBe(29);
    expect(rows[0].eligible_assignment_days).toBe(29);
  });
});
