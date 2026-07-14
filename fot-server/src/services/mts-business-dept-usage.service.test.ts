import { describe, it, expect, vi, beforeEach } from 'vitest';

// Агрегация использования по сотрудникам отдела: несколько номеров у одного
// человека складываются, группы всегда полные, денег/ПДн в выборке нет.

vi.mock('../config/postgres.js', () => ({
  query: vi.fn(async () => []),
  queryOne: vi.fn(async () => null),
  execute: vi.fn(async () => 0),
}));

import { query } from '../config/postgres.js';
import { mtsBusinessDeptUsageService } from './mts-business-dept-usage.service.js';

const q = vi.mocked(query);

const DEPTS = ['d1b2c3d4-0000-0000-0000-000000000001'];

/** Строка агрегата «сотрудник × группа», как её отдаёт SQL (числа — текстом). */
const aggRow = (over: Record<string, unknown>) => ({
  employee_id: '7',
  full_name: 'Иванов Иван',
  tab_number: '0042',
  grp: 'calls',
  count: '0',
  seconds: '0',
  bytes: '0',
  in_count: '0',
  in_seconds: '0',
  out_count: '0',
  out_seconds: '0',
  last_sync: null,
  ...over,
});

/** Строка ростера отдела (список строится от него, а не от агрегата). */
const rosterRow = (over: Record<string, unknown> = {}) => ({
  employee_id: '7',
  full_name: 'Иванов Иван',
  tab_number: '0042',
  has_sim: true,
  ...over,
});

/** query вызывается дважды (агрегат + ростер отдела) — отвечаем по порядку. */
const mockQueries = (usageRows: unknown[], roster: unknown[] = [rosterRow()]): void => {
  q.mockResolvedValueOnce(usageRows as never[]);
  q.mockResolvedValueOnce(roster as never[]);
};

describe('getDepartmentUsageByEmployee', () => {
  beforeEach(() => vi.clearAllMocks());

  it('пустой список отделов → нули, БД не трогаем', async () => {
    const result = await mtsBusinessDeptUsageService.getDepartmentUsageByEmployee([], '2026-07-01', '2026-07-31', null);

    expect(q).not.toHaveBeenCalled();
    expect(result.employees).toEqual([]);
    expect(result.employeesWithSim).toBe(0);
    expect(result.totals.map(g => g.key)).toEqual(['calls', 'internet', 'sms', 'other']);
    expect(result.totals.every(g => g.count === 0)).toBe(true);
  });

  it('два номера одного сотрудника → одна строка, показатели сложены', async () => {
    mockQueries([
      aggRow({ grp: 'calls', count: '10', seconds: '600', in_count: '4', in_seconds: '200', out_count: '6', out_seconds: '400' }),
      aggRow({ grp: 'calls', count: '5', seconds: '300', in_count: '1', in_seconds: '100', out_count: '4', out_seconds: '200' }),
    ]);

    const result = await mtsBusinessDeptUsageService.getDepartmentUsageByEmployee(DEPTS, '2026-07-01', '2026-07-31', null);

    expect(result.employees).toHaveLength(1);
    const calls = result.employees[0].groups.find(g => g.key === 'calls');
    expect(calls).toMatchObject({ count: 15, seconds: 900, inCount: 5, inSeconds: 300, outCount: 10, outSeconds: 600 });
  });

  it('у сотрудника только звонки → в ответе всё равно 4 группы, остальные нулями', async () => {
    mockQueries([aggRow({ grp: 'calls', count: '3', seconds: '180' })]);

    const result = await mtsBusinessDeptUsageService.getDepartmentUsageByEmployee(DEPTS, '2026-07-01', '2026-07-31', null);

    expect(result.employees[0].groups.map(g => g.key)).toEqual(['calls', 'internet', 'sms', 'other']);
    expect(result.employees[0].groups.find(g => g.key === 'sms')?.count).toBe(0);
  });

  it('totals = сумма по всем сотрудникам, включая вх/исх', async () => {
    mockQueries([
      aggRow({ employee_id: '7', grp: 'calls', count: '10', seconds: '600', in_seconds: '200', out_seconds: '400' }),
      aggRow({ employee_id: '9', full_name: 'Петров Пётр', grp: 'calls', count: '4', seconds: '120', in_seconds: '20', out_seconds: '100' }),
      aggRow({ employee_id: '9', full_name: 'Петров Пётр', grp: 'internet', count: '2', bytes: '5000000000' }),
    ], [rosterRow(), rosterRow({ employee_id: '9', full_name: 'Петров Пётр' })]);

    const result = await mtsBusinessDeptUsageService.getDepartmentUsageByEmployee(DEPTS, '2026-07-01', '2026-07-31', null);

    expect(result.employees).toHaveLength(2);
    const calls = result.totals.find(g => g.key === 'calls');
    expect(calls).toMatchObject({ count: 14, seconds: 720, inSeconds: 220, outSeconds: 500 });
    expect(result.totals.find(g => g.key === 'internet')?.bytes).toBe(5_000_000_000);
    expect(result.employeesWithSim).toBe(2);
  });

  it('в группах нет поля amount — деньги руководителю не отдаём', async () => {
    mockQueries([aggRow({ grp: 'calls', count: '1' })]);

    const result = await mtsBusinessDeptUsageService.getDepartmentUsageByEmployee(DEPTS, '2026-07-01', '2026-07-31', null);

    expect(Object.keys(result.totals[0])).not.toContain('amount');
    expect(JSON.stringify(result)).not.toMatch(/amount/i);
  });

  it('SQL: фильтрует уволенных/архивных и не читает ПДн-колонки', async () => {
    mockQueries([]);

    await mtsBusinessDeptUsageService.getDepartmentUsageByEmployee(DEPTS, '2026-07-01', '2026-07-31', null);

    const [sql, params] = q.mock.calls[0];
    expect(sql).toContain('e.is_archived = false');
    expect(sql).toContain("e.employment_status = 'active'");
    expect(sql).not.toMatch(/peer_enc|msisdn_enc|r\.amount/);
    expect(params).toEqual([DEPTS, '2026-07-01', '2026-07-31', null]);
  });

  it('объектный скоуп → список сотрудников уходит параметром в оба запроса', async () => {
    mockQueries([]);

    await mtsBusinessDeptUsageService.getDepartmentUsageByEmployee(DEPTS, '2026-07-01', '2026-07-31', [7, 9]);

    expect(q.mock.calls[0][1]).toEqual([DEPTS, '2026-07-01', '2026-07-31', [7, 9]]);
    expect(q.mock.calls[1][1]).toEqual([DEPTS, [7, 9]]);
  });

  it('весь отдел в списке: нулевая активность и «нет SIM» не отсекаются', async () => {
    mockQueries(
      [aggRow({ employee_id: '7', grp: 'calls', count: '3', seconds: '180' })],
      [
        rosterRow({ employee_id: '7', full_name: 'Иванов Иван', has_sim: true }),
        rosterRow({ employee_id: '9', full_name: 'Петров Пётр', has_sim: true }),   // SIM есть, но за месяц ноль
        rosterRow({ employee_id: '11', full_name: 'Сидоров Сидор', has_sim: false }), // SIM не выдана
      ],
    );

    const result = await mtsBusinessDeptUsageService.getDepartmentUsageByEmployee(DEPTS, '2026-07-01', '2026-07-31', null);

    expect(result.employees).toHaveLength(3);
    const zero = result.employees.find(e => e.employeeId === 9);
    expect(zero?.hasSim).toBe(true);
    expect(zero?.groups.every(g => g.count === 0)).toBe(true);
    const noSim = result.employees.find(e => e.employeeId === 11);
    expect(noSim?.hasSim).toBe(false);
    // Знаменатель KPI считает только тех, кому SIM выдана.
    expect(result.employeesWithSim).toBe(2);
  });

  it('syncedAt = самая свежая загрузка строк, ISO-строкой («данные на …»)', async () => {
    mockQueries([
      aggRow({ grp: 'calls', count: '1', last_sync: new Date('2026-07-14T01:00:00.000Z') }),
      aggRow({ grp: 'sms', count: '1', last_sync: new Date('2026-07-14T03:12:44.000Z') }),
    ]);

    const result = await mtsBusinessDeptUsageService.getDepartmentUsageByEmployee(DEPTS, '2026-07-01', '2026-07-31', null);

    expect(result.syncedAt).toBe('2026-07-14T03:12:44.000Z');
  });

  it('строк нет → syncedAt = null, но сотрудники отдела всё равно в списке', async () => {
    mockQueries([], [rosterRow(), rosterRow({ employee_id: '9', full_name: 'Петров Пётр' })]);

    const result = await mtsBusinessDeptUsageService.getDepartmentUsageByEmployee(DEPTS, '2026-07-01', '2026-07-31', null);

    expect(result.syncedAt).toBeNull();
    expect(result.employees).toHaveLength(2);
    expect(result.employeesWithSim).toBe(2);
  });
});
