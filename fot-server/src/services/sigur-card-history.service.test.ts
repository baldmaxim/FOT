import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * История карты Sigur: один запрос к audit_logs по трём источникам
 * (поштучные правки, привязка/отвязка, итог массового продления и отката).
 */

const h = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('../config/postgres.js', () => ({ query: h.query }));

const { getSigurCardHistory } = await import('./sigur-card-history.service.js');

describe('getSigurCardHistory', () => {
  beforeEach(() => {
    h.query.mockReset();
    h.query.mockResolvedValue([]);
  });

  it('передаёт ID текстом и фильтрует все источники журнала', async () => {
    await getSigurCardHistory(90329, 1430);

    expect(h.query).toHaveBeenCalledTimes(1);
    const [sql, params] = h.query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual(['90329', '1430']);

    expect(sql).toContain(`a.entity_type = 'sigur_employee'`);
    expect(sql).toContain(`'update_card_expiration', 'update_card_binding'`);
    expect(sql).toContain(`a.entity_type = 'sigur_card_binding'`);
    expect(sql).toContain(`a.details->>'sigurEmployeeId' = $1::text`);
    expect(sql).toContain(`a.entity_type = 'sigur_card_bulk_extend'`);
    for (const action of [
      'bulk_extend_cards_completed',
      'bulk_extend_cards_partial',
      'bulk_extend_cards_rollback_completed',
      'bulk_extend_cards_rollback_partial',
    ]) {
      expect(sql).toContain(`'${action}'`);
    }
    expect(sql).not.toContain('bulk_extend_cards_started');
    expect(sql).toContain(`item->>'status' IN ('extended', 'extended_after_retry', 'rollback_extended')`);
    expect(sql).toContain(`jsonb_typeof(a.details->'items') = 'array'`);
    expect(sql).not.toMatch(/::int\b/);
    expect(sql).toContain('ORDER BY e.created_at DESC, e.id DESC');
  });

  it('маппит строки: дата в ISO, автор может отсутствовать', async () => {
    h.query.mockResolvedValue([
      {
        id: 199955,
        created_at: new Date('2026-10-07T05:22:28.351Z'),
        kind: 'bulk_extend',
        start_date: null,
        expiration_date: '2026-12-31',
        previous_expiration: '2026-10-01 23:59:59',
        actor_name: 'Гладкая Наталья Васильевна',
      },
      {
        id: '147189',
        created_at: '2026-08-12T07:32:48.313Z',
        kind: 'update_card_binding',
        start_date: '2021-05-12 21:00:00',
        expiration_date: '2026-12-11 20:59:59',
        previous_expiration: null,
        actor_name: null,
      },
    ]);

    const result = await getSigurCardHistory(148683, 41241);

    expect(result).toEqual([
      {
        id: '199955',
        createdAt: '2026-10-07T05:22:28.351Z',
        kind: 'bulk_extend',
        startDate: null,
        expirationDate: '2026-12-31',
        previousExpiration: '2026-10-01 23:59:59',
        actorName: 'Гладкая Наталья Васильевна',
      },
      {
        id: '147189',
        createdAt: '2026-08-12T07:32:48.313Z',
        kind: 'update_card_binding',
        startDate: '2021-05-12 21:00:00',
        expirationDate: '2026-12-11 20:59:59',
        previousExpiration: null,
        actorName: null,
      },
    ]);
  });
});
