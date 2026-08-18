/**
 * Жизненный цикл закреплений объекта.
 *
 * Ключевой кейс — удаление за прошедший период: оно разрешено по решению пользователя,
 * и единственный след операции — строка в object_kpi_history с полным before_data.
 * Если история перестанет писаться, восстановить денежную ответственность будет нечем.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config/postgres.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock('./object-kpi-history.service.js', () => ({
  recordObjectKpiHistory: vi.fn(),
}));

vi.mock('./object-kpi-roles-cache.service.js', () => ({
  invalidateObjectKpiRolesCache: vi.fn(),
  isEconomicsHeadLive: vi.fn(async () => false),
}));

import { recordObjectKpiHistory } from './object-kpi-history.service.js';
import { isEconomicsHeadLive } from './object-kpi-roles-cache.service.js';
import { deleteAssignment, updateAssignment } from './object-kpi-assignments.service.js';

const OBJECT_ID = '11111111-1111-1111-1111-111111111111';
const ACTOR = { userId: 'user-1', userName: 'Экономист' };

function makeClient(responses: Array<{ rows: unknown[]; rowCount?: number }>) {
  let index = 0;
  return {
    query: vi.fn(async () => {
      const response = responses[index] ?? { rows: [] };
      index += 1;
      return { rows: response.rows, rowCount: response.rowCount ?? response.rows.length };
    }),
  };
}

const assignmentRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'as-1',
  skud_object_id: OBJECT_ID,
  employee_id: 7,
  role_kind: 'construction_manager',
  valid_from: '2020-01-01',
  valid_to: null,
  version: 1,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('deleteAssignment', () => {
  it('закрепление за прошедший период удаляется и попадает в историю', async () => {
    const client = makeClient([
      { rows: [assignmentRow()] },   // SELECT ... FOR UPDATE
      { rows: [], rowCount: 1 },     // DELETE
    ]);

    await deleteAssignment(client as never, ACTOR, 'as-1', 1);

    expect(recordObjectKpiHistory).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        entityKind: 'assignment',
        action: 'delete',
        before: expect.objectContaining({ valid_from: '2020-01-01' }),
      }),
    );
  });

  it('устаревшая версия → 409, а не тихое удаление чужой правки', async () => {
    const client = makeClient([
      { rows: [assignmentRow({ version: 2 })] },
      { rows: [], rowCount: 0 },
    ]);

    await expect(deleteAssignment(client as never, ACTOR, 'as-1', 1))
      .rejects.toMatchObject({ __save: { http: 409, code: 'stale_version' } });
  });

  it('несуществующее закрепление → 404', async () => {
    const client = makeClient([{ rows: [] }]);

    await expect(deleteAssignment(client as never, ACTOR, 'as-1', 1))
      .rejects.toMatchObject({ __save: { http: 404 } });
  });
});

describe('updateAssignment', () => {
  it('правит период любой записи, включая начавшуюся', async () => {
    const client = makeClient([
      { rows: [assignmentRow()] },                                        // SELECT FOR UPDATE
      { rows: [], rowCount: 1 },                                          // UPDATE
      { rows: [assignmentRow({ valid_to: '2026-07-31', version: 2 })] },  // перечитывание
    ]);

    const result = await updateAssignment(client as never, ACTOR, 'as-1', 1, {
      valid_to: '2026-07-31',
    });

    expect(result.valid_to).toBe('2026-07-31');
    expect(recordObjectKpiHistory).toHaveBeenCalled();
  });

  it('оклад вносит админ', async () => {
    const client = makeClient([
      { rows: [assignmentRow()] },
      { rows: [], rowCount: 1 },
      { rows: [assignmentRow({ salary_amount: '350000.00', version: 2 })] },
    ]);

    const result = await updateAssignment(
      client as never, ACTOR, 'as-1', 1, { salary_amount: '350000.00' },
      { employeeId: 7, isAdmin: true },
    );

    expect(result.salary_amount).toBe('350000.00');
    // Право админа не требует похода в БД за ролью.
    expect(isEconomicsHeadLive).not.toHaveBeenCalled();
  });

  it('оклад вносит руководитель эк. отдела — проверка живая, в той же транзакции', async () => {
    (isEconomicsHeadLive as unknown as { mockResolvedValueOnce: (v: boolean) => void })
      .mockResolvedValueOnce(true);
    const client = makeClient([
      { rows: [assignmentRow()] },
      { rows: [], rowCount: 1 },
      { rows: [assignmentRow({ salary_amount: '350000.00', version: 2 })] },
    ]);

    await updateAssignment(
      client as never, ACTOR, 'as-1', 1, { salary_amount: '350000.00' },
      { employeeId: 42, isAdmin: false },
    );

    expect(isEconomicsHeadLive).toHaveBeenCalledWith(client, 42);
  });

  it('экономисту объекта оклад недоступен даже на запись', async () => {
    const client = makeClient([{ rows: [assignmentRow()] }]);

    await expect(updateAssignment(
      client as never, ACTOR, 'as-1', 1, { salary_amount: '350000.00' },
      { employeeId: 5, isAdmin: false },
    )).rejects.toMatchObject({ __save: { http: 403, code: 'salary_forbidden' } });
  });

  it('патч без оклада права не требует — правка периода не сломалась', async () => {
    const client = makeClient([
      { rows: [assignmentRow()] },
      { rows: [], rowCount: 1 },
      { rows: [assignmentRow({ valid_to: '2026-07-31', version: 2 })] },
    ]);

    await updateAssignment(client as never, ACTOR, 'as-1', 1, { valid_to: '2026-07-31' },
      { employeeId: 5, isAdmin: false });

    expect(isEconomicsHeadLive).not.toHaveBeenCalled();
  });

  it('пересечение периодов руководителей остаётся запрещённым', async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [assignmentRow()], rowCount: 1 })
        .mockRejectedValueOnce(Object.assign(new Error('conflict'), { code: '23P01' })),
    };

    await expect(updateAssignment(client as never, ACTOR, 'as-1', 1, { valid_from: '2026-01-01' }))
      .rejects.toMatchObject({ __save: { http: 409, code: 'period_overlap' } });
  });
});
