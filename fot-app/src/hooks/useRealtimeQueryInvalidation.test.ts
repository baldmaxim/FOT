import { describe, expect, it, vi } from 'vitest';

vi.mock('../services/websocket', () => ({ wsService: { on: vi.fn(), off: vi.fn() } }));

const { EVENT_TO_KEYS } = await import('./useRealtimeQueryInvalidation');

/** Блок «График работы» (ключ ['employee-schedule', id, 'plan', год]) сбрасывают смена графика, сотрудника и календаря. */
describe('EVENT_TO_KEYS: график сотрудника', () => {
  it('schedule:changed — по сотруднику, без него (шаблон, массово) — все', () => {
    expect(EVENT_TO_KEYS['schedule:changed']({ employeeId: 48 })).toContainEqual(['employee-schedule', 48]);
    expect(EVENT_TO_KEYS['schedule:changed']({})).toContainEqual(['employee-schedule']);
  });

  it('employee:changed (приём, увольнение, восстановление) — по сотруднику или все', () => {
    expect(EVENT_TO_KEYS['employee:changed']({ entityId: 48 })).toContainEqual(['employee-schedule', 48]);
    expect(EVENT_TO_KEYS['employee:changed']({})).toContainEqual(['employee-schedule']);
  });

  it('production_calendar:changed — все', () => {
    expect(EVENT_TO_KEYS['production_calendar:changed']({})).toContainEqual(['employee-schedule']);
  });
});

describe('EVENT_TO_KEYS: столбец «Зарплата» руководителя (382)', () => {
  it('timesheet_approval:changed (открыли или закрыли подачу) — обновляет столбец', () => {
    expect(EVENT_TO_KEYS['timesheet_approval:changed']({})).toContainEqual(['team-salary']);
  });
});
