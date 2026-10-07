import { describe, expect, it } from 'vitest';
import type { IPendingDecision } from '../services/timesheetApprovalService';
import {
  formatPendingDecisions,
  formatPendingResponsibles,
  isWaitingWeekends,
} from './pendingDecisions';

const CHEPIKOV: IPendingDecision = {
  stage: 'day', responsible_employee_ids: [2063], responsible_names: ['Чепиков Алексей Владимирович'],
  days: ['2026-09-05', '2026-09-06'],
};
const REQUEST: IPendingDecision = {
  stage: 'request', responsible_employee_ids: [31, 55], responsible_names: ['Петров Пётр Петрович', 'Иванов Иван Иванович'],
  days: ['2026-09-12'],
};
const UNASSIGNED: IPendingDecision = { stage: 'day', responsible_employee_ids: [], responsible_names: [], days: ['2026-09-13'] };

describe('isWaitingWeekends', () => {
  it('только поданный табель с нерешёнными выходными', () => {
    expect(isWaitingWeekends({ status: 'submitted', pending_decisions: [CHEPIKOV] })).toBe(true);
    expect(isWaitingWeekends({ status: 'submitted', pending_decisions: [] })).toBe(false);
    expect(isWaitingWeekends({ status: 'approved', pending_decisions: [CHEPIKOV] })).toBe(false);
    expect(isWaitingWeekends(null)).toBe(false);
  });

  it('список подач месяца отдаёт только число', () => {
    expect(isWaitingWeekends({ status: 'submitted', pending_decisions_count: 2 })).toBe(true);
    expect(isWaitingWeekends({ status: 'submitted', pending_decisions_count: 0 })).toBe(false);
    expect(isWaitingWeekends({ status: 'submitted' })).toBe(false);
  });
});

describe('formatPendingDecisions', () => {
  it('кто и какие дни; заявление 1-го этапа помечено; без ответственного — явно', () => {
    expect(formatPendingDecisions([CHEPIKOV, REQUEST, UNASSIGNED])).toBe(
      'Чепиков А. В.: 05.09, 06.09; Петров П. П. / Иванов И. И. (заявление): 12.09; ответственный не назначен: 13.09',
    );
  });

  it('согласующие без повторов — для подсказки «Утвердить»', () => {
    expect(formatPendingResponsibles([CHEPIKOV, { ...CHEPIKOV, stage: 'request' }, UNASSIGNED]))
      .toBe('Чепиков А. В., ответственный не назначен');
  });
});
