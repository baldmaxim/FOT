import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Причина блокировки — последняя запись block/unblock по сотруднику в audit_logs. */

const h = vi.hoisted(() => ({ queryOne: vi.fn() }));

vi.mock('../config/postgres.js', () => ({ queryOne: h.queryOne }));

const { getSigurEmployeeBlockInfo } = await import('./sigur-employee-block.service.js');

describe('getSigurEmployeeBlockInfo', () => {
  beforeEach(() => {
    h.queryOne.mockReset();
  });

  it('берёт последнюю запись block/unblock по ID текстом, пустую причину считает отсутствующей', async () => {
    h.queryOne.mockResolvedValue(null);

    await getSigurEmployeeBlockInfo(150712);

    const [sql, params] = h.queryOne.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual(['150712']);
    expect(sql).toContain(`a.entity_type = 'sigur_employee'`);
    expect(sql).toContain(`a.entity_id = $1::text`);
    expect(sql).toContain(`a.details->>'action' IN ('block', 'unblock')`);
    expect(sql).toContain(`NULLIF(btrim(a.details->>'reason'), '')`);
    expect(sql).toContain('ORDER BY a.created_at DESC, a.id DESC');
  });

  it('последняя — блокировка: дата в ISO, автор и причина', async () => {
    h.queryOne.mockResolvedValue({
      action: 'block',
      created_at: new Date('2026-10-07T07:04:17.799Z'),
      reason: 'Нарушение пропускного режима',
      actor_name: 'Гладкая Наталья Васильевна',
    });

    expect(await getSigurEmployeeBlockInfo(150712)).toEqual({
      blockedAt: '2026-10-07T07:04:17.799Z',
      blockedByName: 'Гладкая Наталья Васильевна',
      reason: 'Нарушение пропускного режима',
    });
  });

  it('старая блокировка без причины и без автора', async () => {
    h.queryOne.mockResolvedValue({
      action: 'block',
      created_at: '2026-08-12T07:32:48.313Z',
      reason: null,
      actor_name: null,
    });

    expect(await getSigurEmployeeBlockInfo(1)).toEqual({
      blockedAt: '2026-08-12T07:32:48.313Z',
      blockedByName: null,
      reason: null,
    });
  });

  it('последняя — разблокировка или записей нет → null', async () => {
    h.queryOne.mockResolvedValueOnce({ action: 'unblock', created_at: new Date(), reason: null, actor_name: 'X' });
    expect(await getSigurEmployeeBlockInfo(1)).toBeNull();

    h.queryOne.mockResolvedValueOnce(null);
    expect(await getSigurEmployeeBlockInfo(1)).toBeNull();
  });
});
