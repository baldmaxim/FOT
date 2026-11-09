import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthenticatedRequest } from '../../types/index.js';

// Шаг бригад расчёта: доли из пакета (peekBrigadeSharesMany), фиксация только needs_fix, состав — если итог не fixed
// или бригада в кандидатах, предварительные доли — только у итоговой open. Пакет и фиксация подменены: их правила
// проверяет brigade-salary.pg.test.
const brigade = vi.hoisted(() => ({ getBrigadeShares: vi.fn(), peekBrigadeShares: vi.fn(), peekBrigadeSharesMany: vi.fn() }));
vi.mock('./brigade-salary.service.js', () => brigade);

const preliminary = vi.hoisted(() => ({
  loadBrigadeCandidates: vi.fn(),
  loadBrigadeContext: vi.fn(),
  resolveOpenBrigadeShares: vi.fn(),
}));
vi.mock('./payroll-calc-preliminary.service.js', () => preliminary);

import { loadFixedBrigadeShares, loadPreliminaryBrigadeShares } from './payroll-calc-brigades.service.js';

const req = { user: { id: 'u1' } } as unknown as AuthenticatedRequest;
const MONTH = '2026-09';
const AS_OF = '2026-09-30';

const open = () => ({ state: 'open', mode: 'objects', distribution: null, output_amount: null, rows: [], objects: [] });
const fixed = (amount: string) => ({
  state: 'fixed', mode: 'objects', distribution: 'ok', output_amount: amount,
  rows: [{ employee_id: 7, ktu: '1.0', counted_minutes: 600, amount, source: 'version', objects: [] }], objects: [],
});
const inputsOf = (ktu: number) => ({ outputs: new Map(), brigadeOutput: null, ktu: new Map([[7, ktu]]) });
const contextOf = (departmentId: string) => ({ departmentId, memberIds: [7], memberships: [], windows: new Map() });
const prelimShares = (departmentId: string) => ({ ...open(), distribution: 'no_output', rows: [], departmentId });

beforeEach(() => {
  vi.clearAllMocks();
  preliminary.loadBrigadeCandidates.mockResolvedValue([]);
  preliminary.loadBrigadeContext.mockImplementation(async (departmentId: string) => contextOf(departmentId));
  preliminary.resolveOpenBrigadeShares.mockImplementation(async (context: { departmentId: string }) => (
    prelimShares(context.departmentId)
  ));
});

describe('loadPreliminaryBrigadeShares', () => {
  it('fixed из пакета: без кандидата — без состава, с кандидатом — состав есть; фиксация не зовётся', async () => {
    preliminary.loadBrigadeCandidates.mockResolvedValue(['b-cand']);
    brigade.peekBrigadeSharesMany.mockResolvedValue(new Map([
      ['b-cand', { state: 'fixed', shares: fixed('100.00') }],
      ['b-plain', { state: 'fixed', shares: fixed('200.00') }],
    ]));

    const step = await loadPreliminaryBrigadeShares(req, MONTH, AS_OF, ['b-plain'], [7]);

    expect(brigade.getBrigadeShares).not.toHaveBeenCalled();
    expect(preliminary.loadBrigadeContext).toHaveBeenCalledTimes(1);
    expect(preliminary.loadBrigadeContext).toHaveBeenCalledWith('b-cand', '2026-09-01', AS_OF);
    expect(preliminary.resolveOpenBrigadeShares).not.toHaveBeenCalled();
    expect(step.shares.get('b-cand')).toEqual(fixed('100.00'));
    expect(step.shares.get('b-plain')).toEqual(fixed('200.00'));
    expect(step.preliminary.size).toBe(0);
    expect(step.contexts.map(context => context.departmentId)).toEqual(['b-cand']);
    expect(brigade.peekBrigadeSharesMany).toHaveBeenCalledWith(['b-cand', 'b-plain'], MONTH);
  });

  it('open из пакета: состав и предварительные доли по вводу из пакета', async () => {
    const inputs = inputsOf(15);
    brigade.peekBrigadeSharesMany.mockResolvedValue(new Map([['b-open', { state: 'open', shares: open(), inputs }]]));

    const step = await loadPreliminaryBrigadeShares(req, MONTH, AS_OF, ['b-open'], []);

    expect(brigade.getBrigadeShares).not.toHaveBeenCalled();
    expect(preliminary.resolveOpenBrigadeShares).toHaveBeenCalledWith(contextOf('b-open'), MONTH, AS_OF, inputs);
    expect(step.shares.get('b-open')).toEqual(prelimShares('b-open'));
    expect([...step.preliminary]).toEqual(['b-open']);
  });

  it('needs_fix: фиксация → fixed (без состава, если не кандидат); фиксация → open (подачу открыли) — ввод читается заново', async () => {
    brigade.peekBrigadeSharesMany.mockResolvedValue(new Map([
      ['b-fix', { state: 'needs_fix' }],
      ['b-reopened', { state: 'needs_fix' }],
    ]));
    brigade.getBrigadeShares.mockImplementation(async (_req: unknown, departmentId: string) => (
      departmentId === 'b-fix' ? fixed('300.00') : open()
    ));

    const step = await loadPreliminaryBrigadeShares(req, MONTH, AS_OF, ['b-fix', 'b-reopened'], []);

    expect(brigade.getBrigadeShares).toHaveBeenCalledTimes(2);
    expect(step.shares.get('b-fix')).toEqual(fixed('300.00'));
    expect(preliminary.loadBrigadeContext).toHaveBeenCalledTimes(1);
    expect(preliminary.loadBrigadeContext).toHaveBeenCalledWith('b-reopened', '2026-09-01', AS_OF);
    expect(preliminary.resolveOpenBrigadeShares).toHaveBeenCalledWith(contextOf('b-reopened'), MONTH, AS_OF, undefined);
    expect([...step.preliminary]).toEqual(['b-reopened']);
  });
});

describe('loadFixedBrigadeShares', () => {
  it('фиксация — только у needs_fix, остальные — из пакета', async () => {
    brigade.peekBrigadeSharesMany.mockResolvedValue(new Map([
      ['b1', { state: 'fixed', shares: fixed('100.00') }],
      ['b2', { state: 'open', shares: open(), inputs: inputsOf(10) }],
      ['b3', { state: 'needs_fix' }],
    ]));
    brigade.getBrigadeShares.mockResolvedValue(fixed('300.00'));

    const step = await loadFixedBrigadeShares(req, MONTH, ['b1', 'b2', 'b3']);

    expect(brigade.getBrigadeShares).toHaveBeenCalledTimes(1);
    expect(brigade.getBrigadeShares).toHaveBeenCalledWith(req, 'b3', MONTH);
    expect(step.shares.get('b1')).toEqual(fixed('100.00'));
    expect(step.shares.get('b2')).toEqual(open());
    expect(step.shares.get('b3')).toEqual(fixed('300.00'));
    expect(step.contexts).toEqual([]);
  });
});
