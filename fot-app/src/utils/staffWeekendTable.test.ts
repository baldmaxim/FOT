import { describe, expect, it } from 'vitest';

import { buildStaffWeekendExport, type IStaffWeekendExportRow } from './staffWeekendTable';

const dzhumaev: IStaffWeekendExportRow = {
  full_name: 'Джумаев Абдусаттор Хуррамович',
  department: 'ЛИНИЯ-Общестрой',
  position: 'Начальник участка отделочных работ',
  days: ['2026-10-04', '2026-10-11', '2026-10-17', '2026-10-18', '2026-10-24', '2026-10-25', '2026-10-31'],
  hours: 37.7,
};
const sokurov: IStaffWeekendExportRow = {
  full_name: 'Сокуров Георгий Леонидович',
  department: 'ЛИНИЯ',
  position: null,
  days: ['2026-10-17', '2026-10-24'],
  hours: 4.8,
};

describe('buildStaffWeekendExport', () => {
  it('столбцы и значения: часы с одним знаком, даты ДД.ММ, месяц и год — в подзаголовке', () => {
    const snapshot = buildStaffWeekendExport([dzhumaev], '2026-10');

    expect(snapshot.columns.map(item => item.label)).toEqual(['№', 'ФИО', 'Отдел', 'Должность', 'Дней', 'Часы', 'Даты']);
    expect(snapshot.rows[0]?.cells).toEqual([
      1,
      'Джумаев Абдусаттор Хуррамович',
      'ЛИНИЯ-Общестрой',
      'Начальник участка отделочных работ',
      7,
      '37,7',
      '04.10, 11.10, 17.10, 18.10, 24.10, 25.10, 31.10',
    ]);
    expect(snapshot.subtitle).toMatch(/^Месяц: /);
    expect(snapshot.subtitle).toMatch(/2026/);
    expect(snapshot.file_name).toMatch(/^Выходные_\d{4}-\d{2}-\d{2}\.xlsx$/);
  });

  it('пустая должность — прочерк, нумерация по порядку', () => {
    const snapshot = buildStaffWeekendExport([dzhumaev, sokurov], '2026-10');

    expect(snapshot.rows[1]?.cells[0]).toBe(2);
    expect(snapshot.rows[1]?.cells[3]).toBe('—');
    expect(snapshot.rows[1]?.cells[5]).toBe('4,8');
  });
});
