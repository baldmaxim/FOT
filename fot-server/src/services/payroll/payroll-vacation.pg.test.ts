import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Отпуск и история зарплаты в карточке «Условия оплаты» на настоящем PostgreSQL:
// приоритеты дня как в табеле, праздники ст. 112, перемычки выходных, остаток от 1С (миграция 323),
// склейка изменений оклада, миграция 286.
// Запускается только при FOT_TEST_PG_URL — ПУСТАЯ тестовая БД (таблицы пересоздаются).
// В обычном прогоне пропускается.

const PG_URL = process.env.FOT_TEST_PG_URL;

const pg = vi.hoisted(() => ({ pool: null as import('pg').Pool | null }));

vi.mock('../../config/postgres.js', async () => {
  const { Pool, types } = await import('pg');
  // Как в config/postgres.ts: DATE — строкой YYYY-MM-DD, INT8 — числом.
  types.setTypeParser(1082, (val: string) => val);
  types.setTypeParser(20, (val: string) => Number.parseInt(val, 10));
  pg.pool = process.env.FOT_TEST_PG_URL ? new Pool({ connectionString: process.env.FOT_TEST_PG_URL, max: 5 }) : null;
  const run = async (sql: string, params?: readonly unknown[]) => {
    if (!pg.pool) throw new Error('FOT_TEST_PG_URL не задан');
    return pg.pool.query(sql, params as unknown[]);
  };
  return {
    query: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rows,
    queryOne: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rows[0] ?? null,
    execute: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rowCount ?? 0,
    withTransaction: async () => { throw new Error('не используется в тесте'); },
  };
});

import { getVacationBalance, getVacationHistory, getVacationSummary } from './payroll-vacation.service.js';
import { getSalaryChanges } from './payroll-terms.service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../docs/migrations/', import.meta.url));
const migration = (name: string): string => readFileSync(`${MIGRATIONS_DIR}${name}`, 'utf8');

const TODAY = '2026-09-24';
const REVIEWER = '00000000-0000-0000-0000-00000000000a';
const AUTHOR = '00000000-0000-0000-0000-00000000000b';

/** Дни табеля: [дата, статус, источник, source_id, approval_status, updated_at, metadata]. */
type DayRow = [string, string, string, string, string, string, string];

const day = (
  date: string, status: string, source: string, sourceId = '',
  approval = 'auto_approved', updatedAt = '2026-09-01T10:00:00Z', metadata = '{}',
): DayRow => [date, status, source, sourceId, approval, updatedAt, metadata];

/** Каждый день диапазона [from, to] одной и той же строкой (заявление разворачивается календарно). */
const range = (from: string, to: string, make: (date: string) => DayRow): DayRow[] => {
  const out: DayRow[] = [];
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(make(d.toISOString().slice(0, 10)));
  }
  return out;
};

const DAYS: DayRow[] = [
  // Приоритет: ручная «работа» перекрывает согласованный отпуск → не отпуск.
  day('2026-03-10', 'vacation', 'leave_request', '100'),
  day('2026-03-10', 'work', 'manual'),
  // Ручной отпуск перекрывает заявление «без сохранения» → отпуск.
  day('2026-03-11', 'unpaid', 'leave_request', '104'),
  day('2026-03-11', 'vacation', 'manual'),
  // Равный приоритет: побеждает свежий updated_at.
  day('2026-03-12', 'vacation', 'manual', 'a', 'auto_approved', '2026-03-01T10:00:00Z'),
  day('2026-03-12', 'work', 'manual', 'b', 'auto_approved', '2026-03-02T10:00:00Z'),
  day('2026-03-13', 'work', 'manual', 'a', 'auto_approved', '2026-03-01T10:00:00Z'),
  day('2026-03-13', 'vacation', 'manual', 'b', 'auto_approved', '2026-03-02T10:00:00Z'),
  // Настоящая объектная правка статус дня не задаёт; мигрированная из day-level — задаёт.
  day('2026-03-17', 'vacation', 'manual_object', 'obj-1'),
  day('2026-03-18', 'vacation', 'manual_object', 'obj-2', 'auto_approved', '2026-09-01T10:00:00Z',
    '{"migrated_from_day_level": true}'),
  // Отклонённая отметка не считается.
  day('2026-03-19', 'vacation', 'manual', '', 'rejected'),
  // Отпуск на майские: 1 мая — праздник (ст. 112), в дни отпуска не входит (ст. 120).
  ...range('2026-05-01', '2026-05-03', date => day(date, 'vacation', 'leave_request', '101')),
  // Отпуск через Новый год: в 2026 году считаются только 9–12 января (1–8 — праздники).
  ...range('2025-12-29', '2026-01-12', date => day(date, 'vacation', 'leave_request', '102')),
  // Будущий согласованный отпуск.
  ...range('2026-10-05', '2026-10-09', date => day(date, 'vacation', 'leave_request', '103')),
  // Без сохранения — ручные отметки.
  ...range('2026-08-01', '2026-08-03', date => day(date, 'unpaid', 'manual')),
];

// Сотрудник 3 — перемычки: руководитель отметил отпуск только по рабочим дням.
const BRIDGE_DAYS: DayRow[] = [
  // Пн–Пт, Пн–Чт, 12.06 (Пт) — праздник, Пн–Пт: Сб/Вс и 12–14.06 — перемычки, один период 01–19.06.
  ...range('2026-06-01', '2026-06-05', date => day(date, 'vacation', 'manual')),
  ...range('2026-06-08', '2026-06-11', date => day(date, 'vacation', 'manual')),
  ...range('2026-06-15', '2026-06-19', date => day(date, 'vacation', 'manual')),
  // Работал в субботу 04.07 — выходные 04–05.07 не отпуск.
  day('2026-07-03', 'vacation', 'manual'),
  day('2026-07-04', 'work', 'manual'),
  day('2026-07-06', 'vacation', 'manual'),
  // Проход по СКУД в субботу 11.07 — тоже не отпуск.
  day('2026-07-10', 'vacation', 'manual'),
  day('2026-07-13', 'vacation', 'manual'),
  // Отпуск через 30.09: по остатку 1С списан по 30.09, октябрьские 9 дней — в ФОТ.
  ...range('2026-09-28', '2026-10-09', date => day(date, 'vacation', 'leave_request', '300')),
];

describe.skipIf(!PG_URL)('отпуск и история зарплаты на PostgreSQL', () => {
  beforeAll(async () => {
    await pg.pool!.query(`
      DROP TABLE IF EXISTS payroll_settings, payroll_item_types, payroll_compensation_terms,
        payroll_vacation_balances, production_calendar, skud_daily_summary,
        attendance_adjustments, leave_requests, user_profiles, org_departments, employees CASCADE;
      CREATE TABLE employees (id integer PRIMARY KEY, hire_date date, dismissal_date date);
      -- Колонки производственного календаря и СКУД, которые читает перемычка.
      CREATE TABLE production_calendar (
        year integer NOT NULL, month integer NOT NULL, holidays date[], mandatory_holidays date[],
        UNIQUE (year, month)
      );
      CREATE TABLE skud_daily_summary (
        employee_id bigint NOT NULL, date date NOT NULL, total_minutes integer, is_present boolean,
        UNIQUE (employee_id, date)
      );
      CREATE TABLE org_departments (id uuid PRIMARY KEY);
      CREATE TABLE user_profiles (id uuid PRIMARY KEY, full_name text);
      CREATE TABLE leave_requests (
        id bigint PRIMARY KEY,
        employee_id integer NOT NULL REFERENCES employees(id),
        reviewer_id uuid REFERENCES user_profiles(id),
        reviewed_at timestamptz
      );
      -- Колонки attendance_adjustments, которые читает выборка (020 + 054).
      CREATE TABLE attendance_adjustments (
        id bigserial PRIMARY KEY,
        employee_id integer NOT NULL REFERENCES employees(id),
        work_date date NOT NULL,
        status text NOT NULL,
        source_type text NOT NULL,
        source_id text NOT NULL DEFAULT '',
        approval_status text NOT NULL DEFAULT 'auto_approved',
        updated_at timestamptz NOT NULL DEFAULT now(),
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        UNIQUE (employee_id, work_date, source_type, source_id)
      );
      INSERT INTO employees (id, hire_date) VALUES
        (1, '2020-01-01'), (2, '2020-01-01'), (3, '2025-12-15'), (4, '2026-10-15'), (5, '2026-05-01');
      INSERT INTO production_calendar (year, month, holidays, mandatory_holidays) VALUES
        (2026, 6, '{2026-06-12}', '{2026-06-12}');
      INSERT INTO skud_daily_summary (employee_id, date, total_minutes, is_present) VALUES
        (3, '2026-07-11', 240, true);
      INSERT INTO user_profiles (id, full_name) VALUES
        ('${REVIEWER}', 'Иванов И.И.'), ('${AUTHOR}', 'Петрова А.А.');
      INSERT INTO leave_requests (id, employee_id, reviewer_id, reviewed_at) VALUES
        (100, 1, '${REVIEWER}', '2026-03-01T09:00:00Z'),
        (101, 1, '${REVIEWER}', '2026-04-20T09:00:00Z'),
        (102, 1, NULL, NULL),
        (103, 1, '${REVIEWER}', '2026-09-01T09:00:00Z'),
        (104, 1, NULL, NULL),
        (300, 3, '${REVIEWER}', '2026-09-20T09:00:00Z');
    `);
    const unpaidNovember = range('2026-11-02', '2026-11-21', date => day(date, 'unpaid', 'manual'));
    for (const [employeeId, rows] of [[1, DAYS], [3, BRIDGE_DAYS], [4, unpaidNovember]] as const) {
      for (const [date, status, source, sourceId, approval, updatedAt, metadata] of rows) {
        await pg.pool!.query(
          `INSERT INTO attendance_adjustments
             (employee_id, work_date, status, source_type, source_id, approval_status, updated_at, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
          [employeeId, date, status, source, sourceId, approval, updatedAt, metadata],
        );
      }
    }
    // Чужой отпуск в тот же день не должен попасть в сводку сотрудника 1.
    await pg.pool!.query(
      `INSERT INTO attendance_adjustments (employee_id, work_date, status, source_type)
       VALUES (2, '2026-03-11', 'vacation', 'manual')`,
    );

    await pg.pool!.query(migration('271_payroll_terms.sql'));
    await pg.pool!.query(migration('282_payroll_terms_bonus_housing.sql'));
    await pg.pool!.query(migration('286_payroll_terms_compensations.sql'));
    await pg.pool!.query(migration('323_payroll_vacation_balances.sql'));
    await pg.pool!.query(
      `INSERT INTO payroll_vacation_balances (employee_id, as_of_date, days) VALUES (3, '2026-09-30', 6.95)`,
    );
  });

  afterAll(async () => {
    await pg.pool?.end();
  });

  it('сводка: приоритеты как в табеле, праздники не считаются, год режется по 1 января', async () => {
    const summary = await getVacationSummary(1, TODAY);

    // 11.03 + 13.03 + 18.03 (мигрированная) + 2–3 мая + 9–12 января = 9.
    expect(summary).toEqual({ year: 2026, today: TODAY, used_days: 9, planned_days: 5, unpaid_days: 3 });
  });

  it('история: заявления по заявлению с согласовавшим, ручные отметки — непрерывными отрезками', async () => {
    const history = await getVacationHistory(1);

    expect(history.map(p => ({
      start: p.start_date, end: p.end_date, status: p.status, days: p.calendar_days,
      holidays: p.holiday_days, source: p.source, request: p.leave_request_id, reviewer: p.reviewer_name,
    }))).toEqual([
      { start: '2026-10-05', end: '2026-10-09', status: 'vacation', days: 5, holidays: 0, source: 'leave_request', request: 103, reviewer: 'Иванов И.И.' },
      { start: '2026-08-01', end: '2026-08-03', status: 'unpaid', days: 3, holidays: 0, source: 'timesheet', request: null, reviewer: null },
      { start: '2026-05-01', end: '2026-05-03', status: 'vacation', days: 3, holidays: 1, source: 'leave_request', request: 101, reviewer: 'Иванов И.И.' },
      { start: '2026-03-18', end: '2026-03-18', status: 'vacation', days: 1, holidays: 0, source: 'timesheet', request: null, reviewer: null },
      { start: '2026-03-13', end: '2026-03-13', status: 'vacation', days: 1, holidays: 0, source: 'timesheet', request: null, reviewer: null },
      { start: '2026-03-11', end: '2026-03-11', status: 'vacation', days: 1, holidays: 0, source: 'timesheet', request: null, reviewer: null },
      { start: '2025-12-29', end: '2026-01-12', status: 'vacation', days: 15, holidays: 8, source: 'leave_request', request: 102, reviewer: null },
    ]);
  });

  it('перемычки: выходные и праздник между днями отпуска — отпуск, рабочая суббота и хвост — нет', async () => {
    const history = await getVacationHistory(3);

    expect(history.map(p => ({ start: p.start_date, end: p.end_date, days: p.calendar_days, holidays: p.holiday_days })))
      .toEqual([
        { start: '2026-09-28', end: '2026-10-09', days: 12, holidays: 0 },
        { start: '2026-07-13', end: '2026-07-13', days: 1, holidays: 0 },
        { start: '2026-07-10', end: '2026-07-10', days: 1, holidays: 0 },
        { start: '2026-07-06', end: '2026-07-06', days: 1, holidays: 0 },
        { start: '2026-07-03', end: '2026-07-03', days: 1, holidays: 0 },
        // 01–19.06 одним периодом: 6–7.06 и 12–14.06 добавлены, 12.06 — праздник; 20–21.06 — хвост, нет.
        { start: '2026-06-01', end: '2026-06-19', days: 19, holidays: 1 },
      ]);

    // 18 дней июня + 4 дня июля + 28–30.09; 1–9.10 — запланированы.
    const summary = await getVacationSummary(3, '2026-09-30');
    expect(summary.used_days).toBe(25);
    expect(summary.planned_days).toBe(9);
  });

  it('остаток: 1С на 30.09 минус отпуск после 30.09, месяц начисляется с 1-го числа', async () => {
    expect(await getVacationBalance(3, '2026-10-21')).toEqual({
      source: '1c', as_of: '2026-09-30', opening_days: '6.95', until: '2026-10-21',
      accrued_months: 1, accrued_days: '2.33', used_days: 9, unpaid_excess_days: 0, current_days: '0.28',
    });
    expect((await getVacationBalance(3, '2026-11-01'))?.current_days).toBe('2.61');
  });

  it('остаток нового сотрудника — с даты приёма, «без сохранения» сверх 14 дней сдвигает начисление', async () => {
    // Принят 15.10 (после выгрузки 30.09), 20 дней без сохранения в ноябре — 6 сверх 14. К 31.12 конец сдвинут
    // на 25.12 — все 3 месяца; к 03.12 — на 27.11, декабрь не засчитан.
    expect(await getVacationBalance(4, '2026-12-31')).toEqual({
      source: 'hire', as_of: '2026-10-15', opening_days: '0.00', until: '2026-12-31',
      accrued_months: 3, accrued_days: '6.99', used_days: 0, unpaid_excess_days: 6, current_days: '6.99',
    });
    expect(await getVacationBalance(4, '2026-12-03')).toMatchObject({ accrued_months: 2, current_days: '4.66' });
  });

  it('принятый до выгрузки без строки 1С — остатка нет', async () => {
    expect(await getVacationBalance(5, '2026-10-21')).toBeNull();
  });

  it('миграция 323 повторно применяется без ошибок', async () => {
    await pg.pool!.query(migration('323_payroll_vacation_balances.sql'));
    const { rows } = await pg.pool!.query('SELECT count(*)::int AS n FROM payroll_vacation_balances');
    expect(rows[0].n).toBe(1);
  });

  it('миграция 286 повторно применяется без ошибок и не пускает отрицательные суммы', async () => {
    await pg.pool!.query(migration('286_payroll_terms_compensations.sql'));

    await expect(pg.pool!.query(
      `INSERT INTO payroll_compensation_terms
         (employee_id, staff_category, calc_type, monthly_salary, effective_from, travel_compensation)
       VALUES (2, 'office', 'salary', 100000, '2026-01-01', -1)`,
    )).rejects.toThrow(/payroll_terms_travel_non_negative/);
  });

  it('история зарплаты: премия 0 = нет, перенос в премию без дельты, смена премии — запись, оклад → часы без дельты', async () => {
    await pg.pool!.query(`
      INSERT INTO payroll_compensation_terms
        (employee_id, staff_category, calc_type, monthly_salary, hourly_rate, bonus_amount,
         effective_from, effective_to, created_by, created_at)
      VALUES
        (1, 'itr', 'salary', 100000, NULL, NULL, '2026-01-01', '2026-02-28', '${AUTHOR}', '2025-12-30T10:00:00Z'),
        (1, 'itr', 'salary', 100000, NULL, 0, '2026-03-01', '2026-03-31', '${REVIEWER}', '2026-02-27T10:00:00Z'),
        (1, 'itr', 'salary', 80000, NULL, 20000, '2026-04-01', '2026-04-30', '${REVIEWER}', '2026-03-30T10:00:00Z'),
        (1, 'itr', 'salary', 80000, NULL, 30000, '2026-05-01', '2026-06-30', '${AUTHOR}', '2026-04-29T10:00:00Z'),
        (1, 'worker', 'hourly', NULL, 450, NULL, '2026-07-01', NULL, '${AUTHOR}', '2026-06-30T10:00:00Z');
    `);

    const changes = await getSalaryChanges(1);

    expect(changes.map(c => ({
      from: c.effective_from, to: c.effective_to, calc: c.calc_type, amount: c.amount, bonus: c.bonus, total: c.total,
      prevCalc: c.prev_calc_type, prev: c.prev_amount, prevBonus: c.prev_bonus, prevTotal: c.prev_total,
      diff: c.diff, pct: c.diff_percent, by: c.changed_by_name,
    }))).toEqual([
      {
        from: '2026-07-01', to: null, calc: 'hourly', amount: '450.0000', bonus: null, total: null,
        prevCalc: 'salary', prev: '80000.00', prevBonus: '30000.00', prevTotal: '110000.00',
        diff: null, pct: null, by: 'Петрова А.А.',
      },
      {
        from: '2026-05-01', to: '2026-06-30', calc: 'salary', amount: '80000.00', bonus: '30000.00', total: '110000.00',
        prevCalc: 'salary', prev: '80000.00', prevBonus: '20000.00', prevTotal: '100000.00',
        diff: '10000.00', pct: '10.0', by: 'Петрова А.А.',
      },
      {
        from: '2026-04-01', to: '2026-04-30', calc: 'salary', amount: '80000.00', bonus: '20000.00', total: '100000.00',
        prevCalc: 'salary', prev: '100000.00', prevBonus: null, prevTotal: '100000.00',
        diff: '0.00', pct: '0.0', by: 'Иванов И.И.',
      },
      {
        from: '2026-01-01', to: '2026-03-31', calc: 'salary', amount: '100000.00', bonus: null, total: '100000.00',
        prevCalc: null, prev: null, prevBonus: null, prevTotal: null,
        diff: null, pct: null, by: 'Петрова А.А.',
      },
    ]);
  });
});
