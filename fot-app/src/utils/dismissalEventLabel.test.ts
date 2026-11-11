import { describe, expect, it } from 'vitest';

import { dismissalEventLabel, showDismissalEventDate } from './dismissalEventLabel';

describe('dismissalEventLabel', () => {
  it('восстановление, отмена, увольнение', () => {
    expect(dismissalEventLabel({ rehired: true, cancelled: false })).toBe('Восстановление');
    expect(dismissalEventLabel({ rehired: false, cancelled: true })).toBe('Отмена увольнения');
    expect(dismissalEventLabel({ rehired: false, cancelled: false })).toBe('Увольнение');
    expect(dismissalEventLabel({})).toBe('Увольнение');
  });

  it('дата увольнения скрыта только у восстановления', () => {
    expect(showDismissalEventDate({ rehired: true, dismissal_date: '2026-11-11' })).toBe(false);
    expect(showDismissalEventDate({ cancelled: true, dismissal_date: '2026-11-20' })).toBe(true);
    expect(showDismissalEventDate({ dismissal_date: '2026-11-11' })).toBe(true);
    expect(showDismissalEventDate({ dismissal_date: null })).toBe(false);
  });
});
