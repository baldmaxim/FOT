import { describe, expect, it } from 'vitest';

import {
  decideDismissalVersion,
  decidePaidCell,
  dismissalWarnings,
  parseDismissalBatch,
  resolveDismissalGraph,
  type IDismissalNode,
} from './payroll-1c-dismissals.rules.js';

const G1 = '11111111-1111-4111-8111-111111111111';
const G2 = '22222222-2222-4222-8222-222222222222';
const G3 = '33333333-3333-4333-8333-333333333333';
const ID_ALL = 'aaaaaaaa-0000-4000-8000-000000000001';

const posted = (over: Record<string, unknown> = {}) => ({
  guid: G1, source_revision: 17, posted: true, supersedes_guid: null,
  number: '0000-002016', date: '2026-11-20', month: '2026-11', organization_inn: '7736255508',
  employee: { employee_id: 1544, id_all: ID_ALL, full_name: 'Савкин Дмитрий Александрович' },
  order: { dismissal_date: '2026-11-20', basis: 'п. 3 ч. 1 ст. 77' },
  accruals: { vacation_compensation: '35602.21', vacation_compensation_days: null, severance: '0.00' },
  ...over,
});

describe('payroll-1c-dismissals.rules — разбор', () => {
  it('проведённый документ: деньги в копейках, ГУИД в нижнем регистре', () => {
    const { docs, errors } = parseDismissalBatch({ documents: [posted({ guid: G1.toUpperCase() })] });
    expect(errors).toEqual([]);
    expect(docs[0]).toMatchObject({
      guid: G1, posted: true, employeeId: 1544, month: '2026-11', compensationCenti: 3560221, severanceCenti: 0,
      compensationDays: null, basis: 'п. 3 ч. 1 ст. 77',
    });
  });

  it('ошибки — все сразу, с номером документа, ГУИДом и путём поля', () => {
    const { errors } = parseDismissalBatch({ documents: [
      posted({ accruals: { vacation_compensation: 35602.21, severance: '1.234' } }),
      posted({ guid: G2, organization_inn: '1234567890', employee: { employee_id: 1544, id_all: 'нет' } }),
      posted({ guid: G2 }),
      posted({ guid: G3, supersedes_guid: G3 }),
    ] });
    const paths = errors.map(error => `${error.index}:${error.path}`);
    expect(paths).toEqual(expect.arrayContaining([
      '0:documents[0].accruals.vacation_compensation',
      '0:documents[0].accruals.severance',
      '1:documents[1].organization_inn',
      '1:documents[1].employee.id_all',
      '2:documents[2].guid',
      '3:documents[3].supersedes_guid',
    ]));
    expect(errors.find(error => error.index === 1)?.guid).toBe(G2);
    expect(parseDismissalBatch({}).errors[0].path).toBe('documents');
    expect(parseDismissalBatch({ documents: [] }).errors[0].path).toBe('documents');
  });

  it('надгробие: минимальная и полная форма одной ревизии — один хеш', () => {
    const minimal = parseDismissalBatch({ documents: [{ guid: G1, source_revision: 18, posted: false }] }).docs[0];
    const full = parseDismissalBatch({ documents: [{ ...posted({ source_revision: 18 }), posted: false }] }).docs[0];
    expect(minimal.contentHash).toBe(full.contentHash);
    expect(minimal.employeeId).toBeNull();
  });
});

describe('payroll-1c-dismissals.rules — версии и граф', () => {
  const stored = { sourceRevision: 17, posted: true, contentHash: 'h17' };
  it('новый, устаревший, без изменений, конфликт ревизии, обновление, распроведение, повтор надгробия', () => {
    expect(decideDismissalVersion(undefined, { sourceRevision: 1, posted: true, contentHash: 'x' })).toBe('new');
    expect(decideDismissalVersion(undefined, { sourceRevision: 1, posted: false, contentHash: 'x' })).toBe('unposted');
    expect(decideDismissalVersion(stored, { sourceRevision: 16, posted: true, contentHash: 'x' })).toBe('stale');
    expect(decideDismissalVersion(stored, { sourceRevision: 17, posted: true, contentHash: 'h17' })).toBe('unchanged');
    expect(decideDismissalVersion(stored, { sourceRevision: 17, posted: true, contentHash: 'other' })).toBe('revision_conflict');
    expect(decideDismissalVersion(stored, { sourceRevision: 18, posted: true, contentHash: 'h18' })).toBe('updated');
    expect(decideDismissalVersion(stored, { sourceRevision: 18, posted: false, contentHash: 't' })).toBe('unposted');
    expect(decideDismissalVersion({ ...stored, posted: false }, { sourceRevision: 19, posted: false, contentHash: 't2' })).toBe('unchanged');
  });

  const node = (guid: string, over: Partial<IDismissalNode> = {}): [string, IDismissalNode] => [guid, {
    guid, posted: true, supersedesGuid: null, employeeId: 1544, month: '2026-11', ...over,
  }];

  it('исправление заменяет исходный; A ← B ← C с распроведённым B — действует только C', () => {
    expect([...resolveDismissalGraph(new Map([node(G1), node(G2, { supersedesGuid: G1 })])).active]).toEqual([G2]);
    const chain = resolveDismissalGraph(new Map([
      node(G1), node(G2, { supersedesGuid: G1, posted: false }), node(G3, { supersedesGuid: G2 }),
    ]));
    expect([...chain.active]).toEqual([G3]);
    // Исправление распроведено — исходный снова действует.
    expect([...resolveDismissalGraph(new Map([node(G1), node(G2, { supersedesGuid: G1, posted: false })])).active]).toEqual([G1]);
    // Предшественник неизвестен — исправление действует.
    expect([...resolveDismissalGraph(new Map([node(G2, { supersedesGuid: G1 })])).active]).toEqual([G2]);
  });

  it('конфликты графа: цикл, два исправления одного, другой сотрудник', () => {
    expect(resolveDismissalGraph(new Map([node(G1, { supersedesGuid: G2 }), node(G2, { supersedesGuid: G1 })])).conflicts.length).toBeGreaterThan(0);
    expect(resolveDismissalGraph(new Map([node(G1), node(G2, { supersedesGuid: G1 }), node(G3, { supersedesGuid: G1 })])).conflicts)
      .toEqual([expect.stringContaining('два проведённых исправления')]);
    expect(resolveDismissalGraph(new Map([node(G1), node(G2, { supersedesGuid: G1, employeeId: 99 })])).conflicts)
      .toEqual([expect.stringContaining('другой сотрудник')]);
  });
});

describe('payroll-1c-dismissals.rules — ячейка «Оплачено»', () => {
  const file = { amountCenti: 1000000, sourceKind: null, sourceBefore: null, updatedBy: 'u1', updatedAt: '2026-11-01T00:00:00Z' };
  it('API берёт ячейку из файла, распроведение возвращает 10 000', () => {
    const take = decidePaidCell(file, true, 1200000, null);
    expect(take).toEqual({
      kind: 'set', amountCenti: 1200000, took: true,
      before: { amount: '10000.00', updated_by: 'u1', updated_at: '2026-11-01T00:00:00Z' },
    });
    const owned = { amountCenti: 1200000, sourceKind: 'api_1c_dismissal', sourceBefore: (take as { before: never }).before, updatedBy: null, updatedAt: null };
    expect(decidePaidCell(owned, true, 1200000, null)).toEqual({ kind: 'keep' });
    expect(decidePaidCell(owned, false, 0, null)).toEqual({ kind: 'restore', before: { amount: '10000.00', updated_by: 'u1', updated_at: '2026-11-01T00:00:00Z' } });
  });

  it('Σ = 0 при действующем документе — строки нет; потом возврат прежнего из журнала', () => {
    expect(decidePaidCell(null, true, 0, null)).toEqual({ kind: 'keep' });
    const del = decidePaidCell(file, true, 0, null);
    expect(del).toMatchObject({ kind: 'delete', took: true });
    const before = { amount: '10000.00', updated_by: 'u1', updated_at: '2026-11-01T00:00:00Z' };
    expect(decidePaidCell(null, false, 0, before)).toEqual({ kind: 'restore', before });
    expect(decidePaidCell(null, false, 0, { absent: true })).toEqual({ kind: 'keep' });
    // Пустую ячейку API занял, после Σ = 0 и новой суммы — прежнее «не было» из журнала, не новый захват.
    expect(decidePaidCell(null, true, 500, { absent: true })).toEqual({ kind: 'set', amountCenti: 500, took: false, before: { absent: true } });
  });

  it('без документов и не API-ячейка — не трогать', () => {
    expect(decidePaidCell(file, false, 0, null)).toEqual({ kind: 'keep' });
  });
});

describe('payroll-1c-dismissals.rules — предупреждения', () => {
  it('нет увольнения в ФОТ, другая дата, нет кода физлица, месяц ≠ дате увольнения', () => {
    expect(dismissalWarnings({ dismissalDate: '2026-11-20', month: '2026-11' }, { dismissalDate: '2026-11-20', idAll: ID_ALL })).toEqual([]);
    expect(dismissalWarnings({ dismissalDate: '2026-11-20', month: '2026-12' }, { dismissalDate: null, idAll: null }).map(item => item.code))
      .toEqual(['fot_not_dismissed', 'id_all_missing_in_fot', 'month_differs_from_dismissal']);
    expect(dismissalWarnings({ dismissalDate: '2026-11-20', month: '2026-11' }, { dismissalDate: '2026-11-18', idAll: ID_ALL })[0].code)
      .toBe('fot_dismissal_date_differs');
  });
});
