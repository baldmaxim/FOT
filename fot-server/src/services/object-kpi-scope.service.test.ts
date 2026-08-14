/**
 * Скоуп KPI: кто какие объекты видит. Здесь же блок эскалации привилегий —
 * закрепления берутся ТОЛЬКО из object_kpi_assignments, fallback на «место работы»
 * в СКУД запрещён.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../config/postgres.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock('./object-kpi-roles-cache.service.js', () => ({
  isEconomicsHead: vi.fn(),
  isEconomicsHeadLive: vi.fn(),
  invalidateObjectKpiRolesCache: vi.fn(),
}));

vi.mock('./access-control.service.js', () => ({
  resolveEffectivePageAccess: vi.fn(),
}));

import { query } from '../config/postgres.js';
import { isEconomicsHead } from './object-kpi-roles-cache.service.js';
import { resolveEffectivePageAccess } from './access-control.service.js';
import { isObjectInScope, resolveObjectKpiScope } from './object-kpi-scope.service.js';
import type { AuthenticatedRequest } from '../types/index.js';

const OBJECT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OBJECT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

const makeReq = (user: Partial<AuthenticatedRequest['user']>): AuthenticatedRequest =>
  ({ user: { is_admin: false, employee_id: 42, ...user } } as AuthenticatedRequest);

beforeEach(() => {
  vi.clearAllMocks();
  (isEconomicsHead as Mock).mockResolvedValue(false);
  (resolveEffectivePageAccess as Mock).mockResolvedValue(false);
});

describe('resolveObjectKpiScope', () => {
  it('админ видит всю стройку', async () => {
    (query as Mock).mockResolvedValue([{ id: OBJECT_A }, { id: OBJECT_B }]);

    const scope = await resolveObjectKpiScope(makeReq({ is_admin: true }));

    expect(scope.is_unrestricted).toBe(true);
    expect(scope.object_ids).toEqual([OBJECT_A, OBJECT_B]);
  });

  it('руководитель эк.отдела видит всю стройку без права на страницу', async () => {
    (isEconomicsHead as Mock).mockResolvedValue(true);
    (query as Mock).mockResolvedValue([{ id: OBJECT_A }]);

    const scope = await resolveObjectKpiScope(makeReq({}));

    expect(scope.is_unrestricted).toBe(true);
    expect(resolveEffectivePageAccess).not.toHaveBeenCalled();
  });

  it('руководителю строительства достаются только его закрепления', async () => {
    (query as Mock).mockResolvedValue([{ skud_object_id: OBJECT_A }]);

    const scope = await resolveObjectKpiScope(makeReq({}), { onDate: '2026-09-15' });

    expect(scope).toEqual({ is_unrestricted: false, object_ids: [OBJECT_A] });
    // Источник — только object_kpi_assignments: employee_skud_object_access
    // (место работы для СКУД, без периода) в KPI-контуре не участвует.
    const sql = (query as Mock).mock.calls[0][0] as string;
    expect(sql).toContain('object_kpi_assignments');
    expect(sql).not.toContain('employee_skud_object_access');
  });

  it('нет закреплений → пустой скоуп, а не доступ ко всему', async () => {
    (query as Mock).mockResolvedValue([]);

    const scope = await resolveObjectKpiScope(makeReq({}), { onDate: '2026-09-15' });

    expect(scope.object_ids).toEqual([]);
    expect(scope.is_unrestricted).toBe(false);
  });

  it('без employee_id скоуп пуст', async () => {
    const scope = await resolveObjectKpiScope(makeReq({ employee_id: null }), { onDate: '2026-09-15' });
    expect(scope.object_ids).toEqual([]);
  });

  it('закрепление с середины месяца попадает в окно, кончающееся этим месяцем', async () => {
    (query as Mock).mockResolvedValue([{ skud_object_id: OBJECT_A }]);

    // Границы окна — первые числа месяцев. Закрепление от 14.08 обязано попасть в
    // окно, у которого to = 2026-08-01: сравнение `valid_from <= to` давало пустой
    // скоуп и прятало объект от руководителя в его же первый месяц.
    await resolveObjectKpiScope(makeReq({}), {
      periodRange: { from: '2026-03-01', to: '2026-08-01' },
    });

    const sql = (query as Mock).mock.calls[0][0] as string;
    expect(sql).toContain("valid_from < ($3::date + INTERVAL '1 month')");
    expect(sql).not.toContain('valid_from <= $3');
    expect((query as Mock).mock.calls[0][1]).toEqual([42, '2026-03-01', '2026-08-01']);
  });

  it('мемоизация на запрос работает только для среза «сегодня»', async () => {
    (query as Mock).mockResolvedValue([{ skud_object_id: OBJECT_A }]);
    const req = makeReq({});

    await resolveObjectKpiScope(req);
    await resolveObjectKpiScope(req);
    expect(query).toHaveBeenCalledTimes(1);

    // Запрос с периодом даёт другой набор объектов и кэшироваться не должен.
    await resolveObjectKpiScope(req, { periodRange: { from: '2026-01-01', to: '2026-06-01' } });
    expect(query).toHaveBeenCalledTimes(2);
  });
});

describe('isObjectInScope', () => {
  it('пробрасывает период: закрытое закрепление всё ещё даёт доступ к своим месяцам', async () => {
    (query as Mock).mockResolvedValue([{ skud_object_id: OBJECT_A }]);

    const allowed = await isObjectInScope(makeReq({}), OBJECT_A, {
      periodRange: { from: '2026-07-01', to: '2026-07-01' },
    });

    expect(allowed).toBe(true);
    expect((query as Mock).mock.calls[0][1]).toEqual([42, '2026-07-01', '2026-07-01']);
  });

  it('чужой объект — false', async () => {
    (query as Mock).mockResolvedValue([{ skud_object_id: OBJECT_A }]);
    await expect(isObjectInScope(makeReq({}), OBJECT_B)).resolves.toBe(false);
  });
});
