import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  query: h.query,
  withTransaction: h.withTransaction,
}));

import {
  listEmployeeTrainings,
  setEmployeeTraining,
  EmployeeOtTrainingError,
} from './employee-ot-training.service.js';

const SCOPE = ['11111111-1111-1111-1111-111111111111'];
const TODAY = '2026-07-27';
const base = { employeeId: 7, userId: 'u-1', scopeIds: SCOPE };

/** Мок клиента транзакции: очередь ответов на client.query в порядке вызовов. */
const makeTxClient = (results: Array<{ rows: unknown[] }>) => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return results.shift() ?? { rows: [] };
    }),
  };
  h.withTransaction.mockImplementation(async (fn: (c: unknown) => Promise<unknown>) => fn(client));
  return { client, calls };
};

beforeEach(() => {
  Object.values(h).forEach(fn => fn.mockReset());
  h.query.mockResolvedValue([]);
});

describe('listEmployeeTrainings', () => {
  it('пустой скоуп — null без запросов', async () => {
    await expect(listEmployeeTrainings(7, [], TODAY)).resolves.toBeNull();
    expect(h.query).not.toHaveBeenCalled();
  });

  it('сотрудник вне скоупа / уволенный / архивный — null', async () => {
    h.query.mockResolvedValueOnce([]);

    await expect(listEmployeeTrainings(7, SCOPE, TODAY)).resolves.toBeNull();

    const [sql] = h.query.mock.calls[0];
    expect(String(sql)).toContain('e.is_archived = false');
    expect(String(sql)).toContain(`e.employment_status <> 'fired'`);
    expect(String(sql)).toContain('e.org_department_id = ANY($2::uuid[])');
    expect(h.query).toHaveBeenCalledTimes(1);
  });

  it('отдаёт все виды каталога, непройденные — со статусом missing', async () => {
    h.query
      .mockResolvedValueOnce([{ id: 7 }])
      .mockResolvedValueOnce([{ kind: 'introductory', passed_on: '2026-07-01', note: null }]);

    const rows = await listEmployeeTrainings(7, SCOPE, TODAY);

    expect(rows).not.toBeNull();
    expect(rows!.length).toBeGreaterThan(5);
    const intro = rows!.find(r => r.kind === 'introductory');
    expect(intro).toMatchObject({ passed_on: '2026-07-01', status: 'valid', note: null });
    expect(rows!.find(r => r.kind === 'workplace')).toMatchObject({
      passed_on: null, valid_until: null, status: 'missing',
    });
  });

  it('профессия возвращается вместе с датой', async () => {
    h.query
      .mockResolvedValueOnce([{ id: 7 }])
      .mockResolvedValueOnce([
        { kind: 'cross_profession', passed_on: '2026-07-01', note: 'Монтажник' },
      ]);

    const rows = await listEmployeeTrainings(7, SCOPE, TODAY);

    expect(rows!.find(r => r.kind === 'cross_profession')).toMatchObject({
      passed_on: '2026-07-01', note: 'Монтажник', status: 'valid',
    });
  });
});

describe('setEmployeeTraining', () => {
  it('пустой скоуп — found:false, транзакция не открывается', async () => {
    await expect(setEmployeeTraining({
      ...base, scopeIds: [], kind: 'workplace', passedOn: '2026-07-01',
    })).resolves.toEqual({ found: false });
    expect(h.withTransaction).not.toHaveBeenCalled();
  });

  it('сотрудник вне скоупа — found:false, целевой SELECT под блокировкой', async () => {
    const { calls } = makeTxClient([{ rows: [] }]);

    await expect(setEmployeeTraining({ ...base, kind: 'workplace', passedOn: '2026-07-01' }))
      .resolves.toEqual({ found: false });

    expect(calls[0].sql).toContain('FOR UPDATE');
    expect(calls).toHaveLength(1);
  });

  it('неизвестный вид отклоняется до обращения к БД', async () => {
    await expect(setEmployeeTraining({
      ...base, kind: 'nope' as never, passedOn: '2026-07-01',
    })).rejects.toBeInstanceOf(EmployeeOtTrainingError);
    expect(h.withTransaction).not.toHaveBeenCalled();
  });

  it('первая установка даты: upsert строки, legacy-таблица не трогается', async () => {
    const { calls } = makeTxClient([
      { rows: [{ id: 7 }] },   // сотрудник найден
      { rows: [] },            // прежней строки нет
      { rows: [] },            // upsert
    ]);

    await expect(setEmployeeTraining({ ...base, kind: 'workplace', passedOn: '2026-07-01' }))
      .resolves.toEqual({
        found: true, changed: true, diff: { passed_on: { from: null, to: '2026-07-01' } },
      });

    expect(calls[2].sql).toContain('INSERT INTO employee_ot_trainings');
    expect(calls[2].sql).toContain('ON CONFLICT (employee_id, kind) DO UPDATE');
    expect(calls.some(c => c.sql.includes('employee_inductions'))).toBe(false);
  });

  it('вводный инструктаж дублируется в employee_inductions', async () => {
    const { calls } = makeTxClient([
      { rows: [{ id: 7 }] },
      { rows: [] },
      { rows: [] },                                                   // upsert обучения
      { rows: [{ inducted_on: null, program_a_on: null }] },          // чтение legacy
      { rows: [] },                                                   // upsert legacy
    ]);

    await setEmployeeTraining({ ...base, kind: 'introductory', passedOn: '2026-07-01' });

    const legacy = calls.find(c => c.sql.includes('INSERT INTO employee_inductions'));
    expect(legacy?.params).toEqual([7, '2026-07-01', null, 'u-1']);
  });

  it('снятие вводного при пустой программе А удаляет строку employee_inductions', async () => {
    const { calls } = makeTxClient([
      { rows: [{ id: 7 }] },
      { rows: [{ kind: 'introductory', passed_on: '2026-07-01', note: null }] },
      { rows: [] },                                                   // DELETE обучения
      { rows: [{ inducted_on: '2026-07-01', program_a_on: null }] },  // чтение legacy
      { rows: [] },                                                   // DELETE legacy
    ]);

    await setEmployeeTraining({ ...base, kind: 'introductory', passedOn: null });

    expect(calls[2].sql).toContain('DELETE FROM employee_ot_trainings');
    expect(calls[4].sql).toContain('DELETE FROM employee_inductions');
  });

  it('снятие вводного при живой программе А оставляет legacy-строку', async () => {
    const { calls } = makeTxClient([
      { rows: [{ id: 7 }] },
      { rows: [{ kind: 'introductory', passed_on: '2026-07-01', note: null }] },
      { rows: [] },
      { rows: [{ inducted_on: '2026-07-01', program_a_on: '2026-05-01' }] },
      { rows: [] },
    ]);

    await setEmployeeTraining({ ...base, kind: 'introductory', passedOn: null });

    const legacy = calls.find(c => c.sql.includes('INSERT INTO employee_inductions'));
    expect(legacy?.params).toEqual([7, null, '2026-05-01', 'u-1']);
  });

  it('повтор той же даты — no-op без записи', async () => {
    const { calls } = makeTxClient([
      { rows: [{ id: 7 }] },
      { rows: [{ kind: 'workplace', passed_on: '2026-07-01', note: null }] },
    ]);

    await expect(setEmployeeTraining({ ...base, kind: 'workplace', passedOn: '2026-07-01' }))
      .resolves.toEqual({ found: true, changed: false, diff: {} });
    expect(calls).toHaveLength(2);
  });

  it('профессия сохраняется отдельным патчем и не стирает дату', async () => {
    const { calls } = makeTxClient([
      { rows: [{ id: 7 }] },
      { rows: [{ kind: 'cross_profession', passed_on: '2026-07-01', note: null }] },
      { rows: [] },
    ]);

    await expect(setEmployeeTraining({ ...base, kind: 'cross_profession', note: 'Монтажник' }))
      .resolves.toEqual({
        found: true, changed: true, diff: { note: { from: null, to: 'Монтажник' } },
      });

    expect(calls[2].params).toEqual([7, 'cross_profession', '2026-07-01', 'Монтажник', 'u-1']);
  });

  it('пустая профессия трактуется как очистка', async () => {
    const { calls } = makeTxClient([
      { rows: [{ id: 7 }] },
      { rows: [{ kind: 'cross_profession', passed_on: '2026-07-01', note: 'Монтажник' }] },
      { rows: [] },
    ]);

    const result = await setEmployeeTraining({ ...base, kind: 'cross_profession', note: '   ' });

    expect(result).toEqual({
      found: true, changed: true, diff: { note: { from: 'Монтажник', to: null } },
    });
    expect(calls[2].params[3]).toBeNull();
  });

  it('снятие даты уносит и профессию', async () => {
    makeTxClient([
      { rows: [{ id: 7 }] },
      { rows: [{ kind: 'cross_profession', passed_on: '2026-07-01', note: 'Монтажник' }] },
      { rows: [] },
    ]);

    await expect(setEmployeeTraining({ ...base, kind: 'cross_profession', passedOn: null }))
      .resolves.toEqual({
        found: true,
        changed: true,
        diff: {
          passed_on: { from: '2026-07-01', to: null },
          note: { from: 'Монтажник', to: null },
        },
      });
  });

  it('профессия без даты — отказ (строка-сирота не создаётся)', async () => {
    makeTxClient([
      { rows: [{ id: 7 }] },
      { rows: [] },
    ]);

    await expect(setEmployeeTraining({ ...base, kind: 'cross_profession', note: 'Монтажник' }))
      .rejects.toBeInstanceOf(EmployeeOtTrainingError);
  });

  it('профессия у вида без hasNote — отказ до обращения к БД', async () => {
    await expect(setEmployeeTraining({ ...base, kind: 'workplace', note: 'Монтажник' }))
      .rejects.toBeInstanceOf(EmployeeOtTrainingError);
    expect(h.withTransaction).not.toHaveBeenCalled();
  });
});
