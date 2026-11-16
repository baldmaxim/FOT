import { describe, expect, it } from 'vitest';

import { buildCorrectionGridMarks, CORRECTIONS_LEGEND_LABEL } from './staffCorrectionsGrid';
import type { IStaffCorrectionTableRow } from './staffCorrectionsTable';

const row = (extra: Partial<IStaffCorrectionTableRow> = {}): IStaffCorrectionTableRow => ({
  id: 1,
  branch_id: 'sklad',
  employee_id: 10,
  full_name: 'Латипов Максим Хикматуллоевич',
  work_date: '2026-11-01',
  status: 'manual',
  hours: 0,
  source: 'table',
  window: 'day',
  object_id: null,
  object_name: null,
  author_name: 'Трофимов Дмитрий Иванович',
  applicant_name: null,
  changed_at: '2026-11-03T14:28:00.000Z',
  reason: 'Выходной день',
  attachments_count: 0,
  skud: { norm_hours: 0, skud_hours: 0, first_entry: '11:24:00', last_exit: null },
  ...extra,
});

describe('buildCorrectionGridMarks', () => {
  it('рамка, подсказка дня и метка у ФИО — по правкам; люди по ФИО', () => {
    const marks = buildCorrectionGridMarks([
      row(),
      row({ id: 2, employee_id: 7, full_name: 'Агарков Д. Н.', work_date: '2026-11-06', hours: 10, reason: null }),
    ]);

    expect(marks.people.map(person => person.full_name)).toEqual(['Агарков Д. Н.', 'Латипов Максим Хикматуллоевич']);
    expect([...marks.keys].sort()).toEqual(['10_2026-11-01', '7_2026-11-06']);
    expect(marks.titles.get('10_2026-11-01'))
      .toBe('Трофимов Дмитрий Иванович, 03.11 17:28: по СКУД 0 (11:24–—) → 0 ч · Выходной день');
    expect(marks.badges.get(10)).toEqual([{ text: '1 корр.', title: CORRECTIONS_LEGEND_LABEL }]);
  });

  it('две правки за день (день и объект) — одна рамка, обе в подсказке; метка считает правки', () => {
    const marks = buildCorrectionGridMarks([
      row({ hours: 4, reason: null }),
      row({ id: 2, window: 'object', object_id: 'o1', object_name: 'ЖК Дом 56', hours: 6, reason: null }),
    ]);

    expect([...marks.keys]).toEqual(['10_2026-11-01']);
    expect(marks.titles.get('10_2026-11-01')).toContain('→ 4 ч; ');
    expect(marks.titles.get('10_2026-11-01')).toContain('→ 6 ч (ЖК Дом 56)');
    expect(marks.people[0]?.days).toEqual(['2026-11-01']);
    expect(marks.badges.get(10)?.[0]?.text).toBe('2 корр.');
  });

  it('правка из заявления — «согласовал, подал»; СКУД ещё считается — «…»', () => {
    const marks = buildCorrectionGridMarks([row({
      source: 'request', author_name: 'Иванов И. И.', applicant_name: 'Латипов М. Х.', skud: null, reason: null,
    })]);
    expect(marks.titles.get('10_2026-11-01'))
      .toBe('Иванов И. И. (согласовал), подал Латипов М. Х., 03.11 17:28: по СКУД … → 0 ч');
  });

  it('нет правок — пусто', () => {
    const marks = buildCorrectionGridMarks([]);
    expect(marks.people).toEqual([]);
    expect(marks.keys.size).toBe(0);
  });
});
