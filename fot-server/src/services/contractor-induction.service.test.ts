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
  archiveInductedPerson,
  countInductionByOrg,
  createInductedPerson,
  listInductedByOrg,
  updateInductedPerson,
  OtTrainingKindError,
} from './contractor-induction.service.js';

const ORG = '11111111-1111-1111-1111-111111111111';
const OTHER_ORG = '22222222-2222-2222-2222-222222222222';
const PERSON = '33333333-3333-3333-3333-333333333333';
const REV = '2026-07-27T09:00:00.000Z';
const TODAY = '2026-07-27';

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

describe('listInductedByOrg', () => {
  it('скрывает архивные, отдаёт статус и legacy-поле inducted_on', async () => {
    h.query
      .mockResolvedValueOnce([
        { id: PERSON, org_department_id: ORG, full_name: 'Иванов И.И.', updated_at: REV },
      ])
      .mockResolvedValueOnce([
        { person_id: PERSON, kind: 'introductory', passed_on: '2026-07-01' },
      ]);

    const rows = await listInductedByOrg(ORG, TODAY);

    expect(String(h.query.mock.calls[0][0])).toContain('p.deleted_at IS NULL');
    expect(rows[0].inducted_on).toBe('2026-07-01');
    expect(rows[0].updated_at).toBe(REV);
    // У подрядчика вид один: вводный пройден — замечаний нет.
    expect(rows[0].row_status).toBe('ok');
    expect(rows[0].missing).toEqual([]);
    expect(rows[0].trainings).toHaveLength(1);
  });

  it('без вводного инструктажа строка требует внимания', async () => {
    h.query
      .mockResolvedValueOnce([
        { id: PERSON, org_department_id: ORG, full_name: 'Сидоров С.С.', updated_at: REV },
      ])
      .mockResolvedValueOnce([]);

    const rows = await listInductedByOrg(ORG, TODAY);

    expect(rows[0].row_status).toBe('alert');
    expect(rows[0].missing).toEqual(['introductory']);
  });

  it('человек без единой даты — inducted_on null (а не «сегодня»)', async () => {
    h.query
      .mockResolvedValueOnce([
        { id: PERSON, org_department_id: ORG, full_name: 'Петров П.П.', updated_at: REV },
      ])
      .mockResolvedValueOnce([]);

    const rows = await listInductedByOrg(ORG, TODAY);

    expect(rows[0].inducted_on).toBeNull();
    expect(rows[0].trainings).toEqual([]);
  });
});

describe('countInductionByOrg', () => {
  it('считает всего/требуют внимания по организациям', async () => {
    h.query
      .mockResolvedValueOnce([
        { id: 'p1', org_department_id: ORG, full_name: 'A', updated_at: REV },
        { id: 'p2', org_department_id: ORG, full_name: 'B', updated_at: REV },
      ])
      .mockResolvedValueOnce([{ person_id: 'p1', kind: 'introductory', passed_on: '2026-07-01' }]);

    const counts = await countInductionByOrg([ORG], TODAY);

    // p1 прошёл вводный, p2 нет — замечание только у второго.
    expect(counts.get(ORG)).toEqual({ total: 2, alert: 1, warning: 0 });
  });

  it('пустой список организаций — без запросов', async () => {
    await expect(countInductionByOrg([], TODAY)).resolves.toEqual(new Map());
    expect(h.query).not.toHaveBeenCalled();
  });
});

describe('createInductedPerson', () => {
  it('создаёт запись и дублирует вводный инструктаж в legacy-колонку', async () => {
    const { calls } = makeTxClient([
      { rows: [{ id: PERSON }] },  // INSERT персоны
      { rows: [] },                // прежних дат нет
    ]);

    const result = await createInductedPerson({
      orgDepartmentId: ORG,
      fullName: 'Иванов И.И.',
      trainings: { introductory: '2026-07-01' },
      userId: 'u-1',
    });

    expect(result.id).toBe(PERSON);
    expect(result.diff).toEqual({ introductory: { from: null, to: '2026-07-01' } });
    // Персона создаётся с NULL в legacy-колонке — DEFAULT CURRENT_DATE больше не врёт.
    expect(calls[0].sql).toContain('INSERT INTO contractor_inducted_persons');
    expect(calls[0].sql).toContain('NULL');
    const dual = calls.find(c => c.sql.includes('SET inducted_on'));
    expect(dual?.params).toEqual([PERSON, '2026-07-01']);
  });

  it('без дат legacy-колонка не трогается (остаётся NULL)', async () => {
    const { calls } = makeTxClient([{ rows: [{ id: PERSON }] }]);

    await createInductedPerson({
      orgDepartmentId: ORG,
      fullName: 'Иванов И.И.',
      trainings: {},
      userId: 'u-1',
    });

    expect(calls.some(c => c.sql.includes('SET inducted_on'))).toBe(false);
  });

  it('вид, который ведут кадры по своим сотрудникам, подрядчику не записать', async () => {
    for (const kind of ['workplace', 'program_a', 'cross_profession']) {
      await expect(createInductedPerson({
        orgDepartmentId: ORG,
        fullName: 'Иванов И.И.',
        trainings: { [kind]: '2026-07-01' } as never,
        userId: 'u-1',
      })).rejects.toBeInstanceOf(OtTrainingKindError);
    }
    expect(h.withTransaction).not.toHaveBeenCalled();
  });
});

describe('updateInductedPerson', () => {
  const base = { id: PERSON, orgIds: [ORG], expectedUpdatedAt: REV, userId: 'u-1' };

  it('пустой скоуп — not_found без транзакции', async () => {
    await expect(updateInductedPerson({ ...base, orgIds: [], trainings: {} }))
      .resolves.toEqual({ status: 'not_found' });
    expect(h.withTransaction).not.toHaveBeenCalled();
  });

  it('чужая организация или архивная запись — not_found', async () => {
    const { calls } = makeTxClient([{ rows: [] }]);

    await expect(updateInductedPerson({ ...base, orgIds: [OTHER_ORG], trainings: {} }))
      .resolves.toEqual({ status: 'not_found' });

    expect(calls[0].sql).toContain('p.deleted_at IS NULL');
    expect(calls[0].sql).toContain('FOR UPDATE');
    expect(calls).toHaveLength(1);
  });

  it('устаревшая ревизия — conflict, ничего не пишется', async () => {
    const { calls } = makeTxClient([
      { rows: [{ full_name: 'Иванов И.И.', updated_at: '2026-07-27T10:00:00.000Z' }] },
    ]);

    await expect(updateInductedPerson({ ...base, trainings: { introductory: '2026-07-02' } }))
      .resolves.toEqual({ status: 'conflict' });
    expect(calls).toHaveLength(1);
  });

  it('патч трогает только присланные виды', async () => {
    const { calls } = makeTxClient([
      { rows: [{ full_name: 'Иванов И.И.', updated_at: REV }] },
      { rows: [{ kind: 'introductory', passed_on: '2026-04-01' }] },
      { rows: [] },  // upsert вводного
      { rows: [] },  // bump updated_at
    ]);

    const result = await updateInductedPerson({ ...base, trainings: { introductory: '2026-07-02' } });

    expect(result).toEqual({
      status: 'ok',
      diff: { introductory: { from: '2026-04-01', to: '2026-07-02' } },
      nameFrom: null,
    });
    expect(calls[1].params).toEqual([PERSON, ['introductory']]);
    expect(calls[2].sql).toContain('ON CONFLICT (person_id, kind) DO UPDATE');
  });

  it('снятие даты — DELETE строки, вводный обнуляет и legacy-колонку', async () => {
    const { calls } = makeTxClient([
      { rows: [{ full_name: 'Иванов И.И.', updated_at: REV }] },
      { rows: [{ kind: 'introductory', passed_on: '2026-07-01' }] },
      { rows: [] },  // DELETE
      { rows: [] },  // dual-write NULL
      { rows: [] },  // bump updated_at
    ]);

    const result = await updateInductedPerson({ ...base, trainings: { introductory: null } });

    expect(result).toEqual({
      status: 'ok',
      diff: { introductory: { from: '2026-07-01', to: null } },
      nameFrom: null,
    });
    expect(calls[2].sql).toContain('DELETE FROM contractor_person_trainings');
    const dual = calls.find(c => c.sql.includes('SET inducted_on'));
    expect(dual?.params).toEqual([PERSON, null]);
  });

  it('повтор той же даты — no-op: ни записи, ни bump ревизии', async () => {
    const { calls } = makeTxClient([
      { rows: [{ full_name: 'Иванов И.И.', updated_at: REV }] },
      { rows: [{ kind: 'introductory', passed_on: '2026-07-02' }] },
    ]);

    const result = await updateInductedPerson({ ...base, trainings: { introductory: '2026-07-02' } });

    expect(result).toEqual({ status: 'ok', diff: {}, nameFrom: null });
    expect(calls).toHaveLength(2);
  });

  it('правка ФИО без дат bump-ит ревизию и возвращает прежнее имя', async () => {
    const { calls } = makeTxClient([
      { rows: [{ full_name: 'Иванов И.И.', updated_at: REV }] },
      { rows: [] },  // UPDATE full_name
      { rows: [] },  // bump updated_at
    ]);

    const result = await updateInductedPerson({ ...base, fullName: 'Иванов И.П.' });

    expect(result).toEqual({ status: 'ok', diff: {}, nameFrom: 'Иванов И.И.' });
    expect(calls[1].sql).toContain('SET full_name');
  });

  it('вид, который ведут кадры по своим сотрудникам, отклоняется', async () => {
    await expect(updateInductedPerson({ ...base, trainings: { workplace: '2026-07-01' } as never }))
      .rejects.toBeInstanceOf(OtTrainingKindError);
  });
});

describe('archiveInductedPerson', () => {
  it('архивирует и возвращает снимок, не удаляя историю обучения', async () => {
    const { calls } = makeTxClient([
      { rows: [{ id: PERSON, full_name: 'Иванов И.И.', org_department_id: ORG }] },
      { rows: [{ kind: 'introductory', passed_on: '2026-07-01' }] },
      { rows: [] },
    ]);

    const snapshot = await archiveInductedPerson(PERSON, [ORG], 'u-1');

    expect(snapshot).toEqual({
      id: PERSON,
      full_name: 'Иванов И.И.',
      org_department_id: ORG,
      trainings: { introductory: '2026-07-01' },
    });
    expect(calls[2].sql).toContain('SET deleted_at = now()');
    expect(calls.some(c => c.sql.includes('DELETE FROM contractor_person_trainings'))).toBe(false);
  });

  it('чужая организация — null', async () => {
    makeTxClient([{ rows: [] }]);
    await expect(archiveInductedPerson(PERSON, [OTHER_ORG], 'u-1')).resolves.toBeNull();
  });

  it('пустой скоуп — null без транзакции', async () => {
    await expect(archiveInductedPerson(PERSON, [], 'u-1')).resolves.toBeNull();
    expect(h.withTransaction).not.toHaveBeenCalled();
  });
});
