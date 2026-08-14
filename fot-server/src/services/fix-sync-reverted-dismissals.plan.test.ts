import { describe, expect, it } from 'vitest';

import { planAssignments } from '../../scripts/fix-sync-reverted-dismissals.js';

/**
 * Алгоритм правки назначений в repair-скрипте. На проде большинство открытых
 * назначений вне архива созданы синком уже ПОСЛЕ отката и начинаются позже даты
 * увольнения — «закрыть датой D» дало бы конец раньше начала.
 */

const D = '2026-08-12';
const EVENT_AT = '2026-08-12T20:01:35.000Z';

const row = (over: Partial<{
  id: string; org_department_id: string | null; position_id: string | null;
  effective_from: string; effective_to: string | null; change_reason: string | null; created_at: string;
}> = {}) => ({
  id: 'a1',
  org_department_id: 'brigade',
  position_id: null,
  effective_from: '2026-07-01',
  effective_to: null,
  change_reason: 'Синхронизация Sigur',
  created_at: '2026-07-01T10:00:00.000Z',
  ...over,
});

describe('planAssignments — правка открытых назначений вне архива', () => {
  it('назначение началось до даты увольнения → закрывается днём D', () => {
    const actions = planAssignments([row({ effective_from: '2026-07-01' })], D, EVENT_AT);
    expect(actions).toEqual([{ kind: 'close', id: 'a1', effectiveTo: D }]);
  });

  it('назначение началось в день увольнения → тоже закрывается днём D', () => {
    const actions = planAssignments([row({ effective_from: D })], D, EVENT_AT);
    expect(actions).toEqual([{ kind: 'close', id: 'a1', effectiveTo: D }]);
  });

  it('sync-артефакт после отката (позже D, причина синка, создан после события) → удаление', () => {
    const actions = planAssignments([row({
      effective_from: '2026-08-13',
      change_reason: 'Восстановление (синхронизация Sigur)',
      created_at: '2026-08-13T05:00:00.000Z',
    })], D, EVENT_AT);
    expect(actions).toEqual([{ kind: 'delete', id: 'a1', reason: 'Восстановление (синхронизация Sigur)' }]);
  });

  it('назначение позже D с ручной причиной → сотрудник целиком уходит на ручную сверку', () => {
    const actions = planAssignments([row({
      effective_from: '2026-08-20',
      change_reason: 'Перевод по приказу',
      created_at: '2026-08-20T05:00:00.000Z',
    })], D, EVENT_AT);
    expect(actions).toBeNull();
  });

  it('назначение позже D с причиной синка, но созданное ДО увольнения → ручная сверка', () => {
    // Не артефакт отката: запись существовала раньше, чем случилось увольнение.
    const actions = planAssignments([row({
      effective_from: '2026-08-20',
      change_reason: 'Синхронизация Sigur',
      created_at: '2026-08-01T05:00:00.000Z',
    })], D, EVENT_AT);
    expect(actions).toBeNull();
  });

  it('назначение позже D без причины → ручная сверка', () => {
    const actions = planAssignments([row({
      effective_from: '2026-08-20',
      change_reason: null,
      created_at: '2026-08-20T05:00:00.000Z',
    })], D, EVENT_AT);
    expect(actions).toBeNull();
  });

  it('несколько назначений: один спорный обнуляет весь план сотрудника', () => {
    const actions = planAssignments([
      row({ id: 'ok', effective_from: '2026-07-01' }),
      row({ id: 'bad', effective_from: '2026-08-20', change_reason: 'Перевод по приказу' }),
    ], D, EVENT_AT);
    expect(actions).toBeNull();
  });

  it('открытых назначений вне архива нет → пустой список действий', () => {
    expect(planAssignments([], D, EVENT_AT)).toEqual([]);
  });
});
