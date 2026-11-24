import { describe, expect, it } from 'vitest';

import type { IDormitoryCandidate } from '../services/dormitoryService';
import { parsePenaltyForm, penaltyCandidateNote, penaltyItemText } from './dormitoryPenalties';

// «История взысканий» (миграция 378): форма записи и подписи предупреждения «Заселить».

const candidate = (penalty: IDormitoryCandidate['penalty']): IDormitoryCandidate => ({
  id: 1, full_name: 'Иванов Иван', department: null, position: null, penalty,
});

describe('«История взысканий»', () => {
  it('форма: сотрудник, дата не позже сегодня, дата или информация — хотя бы одно', () => {
    const today = '2026-11-24';
    expect(parsePenaltyForm({ employeeSelected: false, penaltyDate: '', note: 'x' }, today))
      .toEqual({ ok: false, field: 'employee', message: 'Выберите сотрудника' });
    expect(parsePenaltyForm({ employeeSelected: true, penaltyDate: '', note: '   ' }, today))
      .toEqual({ ok: false, field: 'note', message: 'Укажите дату или информацию' });
    expect(parsePenaltyForm({ employeeSelected: true, penaltyDate: '2026-11-25', note: '' }, today))
      .toEqual({ ok: false, field: 'penalty_date', message: 'Дата взыскания — не позже сегодня' });
    expect(parsePenaltyForm({ employeeSelected: true, penaltyDate: '', note: '  Драка   ночью ' }, today))
      .toEqual({ ok: true, payload: { penalty_date: null, note: 'Драка ночью' } });
    expect(parsePenaltyForm({ employeeSelected: true, penaltyDate: '2026-11-24', note: '' }, today))
      .toEqual({ ok: true, payload: { penalty_date: '2026-11-24', note: null } });
  });

  it('пометка в поиске и строка предупреждения', () => {
    expect(penaltyCandidateNote(candidate('yes'))).toBe('⚠ Есть взыскания');
    expect(penaltyCandidateNote(candidate('check'))).toBe('⚠ Проверьте взыскания: совпадает ФИО');
    expect(penaltyCandidateNote(candidate(null))).toBeNull();
    expect(penaltyCandidateNote(candidate(undefined))).toBeNull();
    expect(penaltyItemText({ source: 'list', level: 'yes', full_name: 'Иванов Иван', penalty_date: '2026-10-05', note: 'Драка' }))
      .toBe('05.10.2026 · Список · Драка');
    expect(penaltyItemText({ source: 'blacklist', level: 'check', full_name: 'Иванов Иван', penalty_date: null, note: 'Хищение' }))
      .toBe('Чёрный список (пропуска) · Хищение · Иванов Иван');
  });
});
