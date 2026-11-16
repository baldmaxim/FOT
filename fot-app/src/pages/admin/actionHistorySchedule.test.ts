import { describe, expect, it } from 'vitest';
import { formatScheduleChangeDetails } from './actionHistorySchedule';

const OFFICE = 'ОФИС пятидневка + рос.праздники + пт 7 час';
const WARRANTY = 'Гарантийный отдел график 5дн+2 суб с 01.04.22г';
const FIO = 'Гнатовский Виктор Викторович';

describe('formatScheduleChangeDetails', () => {
  it('назначение: было → стало с даты, график по умолчанию помечен', () => {
    expect(formatScheduleChangeDetails({
      employee_full_name: FIO,
      operation: 'assign',
      date: '2026-10-01',
      from_schedule_name: OFFICE,
      from_is_default: true,
      to_schedule_name: WARRANTY,
      to_is_default: false,
    })).toBe(`${FIO}: «${OFFICE}» (по умолчанию) → «${WARRANTY}» с 01.10.2026`);
  });

  it('удаление записи: что удалено и что действует с её даты', () => {
    expect(formatScheduleChangeDetails({
      employee_full_name: FIO,
      operation: 'delete',
      date: '2026-10-01',
      from_schedule_name: WARRANTY,
      from_is_default: false,
      to_schedule_name: OFFICE,
      to_is_default: true,
    })).toBe(`${FIO}: удалена запись «${WARRANTY}», с 01.10.2026 — «${OFFICE}» (по умолчанию)`);
  });

  it('исправление дат: начало и якорь записи было → стало', () => {
    expect(formatScheduleChangeDetails({
      employee_full_name: FIO,
      operation: 'fix',
      assignment_id: 'a-1',
      to_schedule_name: WARRANTY,
      to_is_default: false,
      before: [{ id: 'a-1', effective_from: '2026-10-01', anchor_date: null }],
      after: [{ id: 'a-1', effective_from: '2026-09-15', anchor_date: '2026-09-15' }],
    })).toBe(`${FIO}: «${WARRANTY}»: с 01.10.2026 → с 15.09.2026, якорь — → 15.09.2026`);
  });

  it('бригада и сотрудник без ФИО', () => {
    expect(formatScheduleChangeDetails({
      employee_id: 101,
      operation: 'brigade_reset',
      date: '2026-11-01',
      from_schedule_name: '6+0 (11 ч)',
      from_is_default: false,
      to_schedule_name: OFFICE,
      to_is_default: true,
      brigade_names: [' Бр. Монолит '],
    })).toBe(`сотрудник #101: «6+0 (11 ч)» → «${OFFICE}» (по умолчанию) с 01.11.2026 (бригада «Бр. Монолит»)`);
  });
});
