import { describe, expect, it } from 'vitest';

import type { ICompensationMonthRow, IDormitoryStay } from '../services/dormitoryService';
import {
  apartmentTitle,
  COMPENSATION_COLUMNS,
  compensationTone,
  compensationTotals,
  dismissedTone,
  DORMITORY_HISTORY_COLUMNS,
  formatPassTime,
  formatPeriod,
  housingMonthOptions,
  livesOn,
  touchesMonth,
} from './housingTables';

const stay = (over: Partial<IDormitoryStay> = {}): IDormitoryStay => ({
  id: 1, employee_id: 1, full_name: 'Баратов Илёс Шералиевич', department: null, position: null, kind: 'dormitory',
  check_in: '2026-09-01', check_out: null, address: 'Общ. Верхнелихоборская 6', amount: null,
  employment_status: 'active', dismissal_date: null, ...over,
});

describe('«Проживание»: таблицы вкладок', () => {
  it('крайний проход — «19.11.2026 6:17», нет — прочерк', () => {
    expect(formatPassTime('2026-11-19T06:17:13')).toBe('19.11.2026 6:17');
    expect(formatPassTime('2026-11-18T18:02:26')).toBe('18.11.2026 18:02');
    expect(formatPassTime(null)).toBe('—');
  });

  it('отпуск — «10.12–23.12.2026»; через год — оба года', () => {
    expect(formatPeriod('2026-12-10', '2026-12-23')).toBe('10.12–23.12.2026');
    expect(formatPeriod('2026-12-28', '2027-01-10')).toBe('28.12.2026–10.01.2027');
    expect(formatPeriod(null, null)).toBe('—');
  });

  it('уволенный — подсветка с датой; увольнение сегодня — уже уволен; работающий — нет', () => {
    expect(dismissedTone(stay({ employment_status: 'fired', dismissal_date: '2026-11-02' }), '2026-11-19'))
      .toEqual({ tone: 'dismissed', hint: 'Уволен 02.11.2026' });
    expect(dismissedTone(stay({ dismissal_date: '2026-11-19' }), '2026-11-19')?.tone).toBe('dismissed');
    expect(dismissedTone(stay({ dismissal_date: '2026-11-30' }), '2026-11-19')).toBe(null);
    expect(dismissedTone(stay(), '2026-11-19')).toBe(null);
  });

  it('живёт на дату — [въезд, выезд): в день выезда уже нет', () => {
    expect(livesOn(stay({ check_out: '2026-11-19' }), '2026-11-18')).toBe(true);
    expect(livesOn(stay({ check_out: '2026-11-19' }), '2026-11-19')).toBe(false);
    expect(livesOn(stay({ check_in: '2026-11-20' }), '2026-11-19')).toBe(false);
  });

  it('квартира — адрес с пометкой 1С', () => {
    const apartment = { id: 1, address: 'Ляпидевского 12-58', note: 'семейная РФ', rooms: 2, places: 3, price: '70000.00', paid_until: null };
    expect(apartmentTitle(apartment)).toBe('Ляпидевского 12-58 (семейная РФ)');
    expect(apartmentTitle({ ...apartment, note: null })).toBe('Ляпидевского 12-58');
  });

  it('«Итого» компенсации — в копейках, не посчитанный месяц не складывается', () => {
    const row = (amount: string | null): ICompensationMonthRow => ({
      ...stay({ kind: 'apartment', amount: '630.00' }), month: '2026-10', month_amount: amount, worked_days: null, weekend_days: null,
    });
    expect(compensationTotals([row('19530.00'), row('17010.00'), row('0.10'), row('0.20'), row(null)])?.export)
      .toEqual({ full_name: 'Итого', month_amount: '36540.30' });
    expect(compensationTotals([])).toBe(null);
  });
});

describe('«Компенсация аренды»: пауза и бригада (374)', () => {
  const row = (over: Partial<ICompensationMonthRow> = {}): ICompensationMonthRow => ({
    ...stay({ kind: 'apartment', address: null, amount: '630.00', full_name: 'Киличов Самандар Рустамович' }),
    month: '2026-11', month_amount: '0.00', worked_days: 0, weekend_days: 0, ...over,
  });
  const text = (key: string, value: ICompensationMonthRow) => COMPENSATION_COLUMNS.find(column => column.key === key)!.text(value);

  it('начало — первой записи цепочки, прежний бэкенд — въезд; пауза и возобновление — даты или прочерк', () => {
    const resumed = row({ check_in: '2026-12-01', compensation_start: '2026-09-01', paused_from: '2026-11-16', resumed_from: '2026-12-01' });
    expect(text('check_in', resumed)).toBe('01.09.2026');
    expect(text('paused_from', resumed)).toBe('16.11.2026');
    expect(text('resumed_from', resumed)).toBe('01.12.2026');
    expect(text('check_in', row())).toBe('01.09.2026');
    expect(text('paused_from', row())).toBe('—');
  });

  it('в бригаде — жёлтая строка с датой; уволенный в бригаде — цвет «уволен», подсказки вместе', () => {
    expect(compensationTone(row({ brigade_from: '2026-11-16', brigade_to: null }), '2026-11-20'))
      .toEqual({ tone: 'brigade', hint: 'В бригаде с 16.11.2026 — компенсация аренды не начисляется' });
    expect(compensationTone(row({ brigade_from: '2026-10-01', brigade_to: '2026-11-11' }), '2026-11-20'))
      .toEqual({ tone: 'brigade', hint: 'В бригаде 01.10–11.11.2026 — в эти дни компенсация аренды не начисляется' });
    expect(compensationTone(row({ brigade_from: '2026-11-16', employment_status: 'fired', dismissal_date: '2026-11-18' }), '2026-11-20'))
      .toEqual({ tone: 'dismissed', hint: 'Уволен 18.11.2026 · В бригаде с 16.11.2026 — компенсация аренды не начисляется' });
    expect(compensationTone(row(), '2026-11-20')).toBe(null);
  });
});

describe('«Проживание»: месяц и выгрузка (20.11.2026)', () => {
  it('месяцы выбора — с 09.2026 по следующий за текущим', () => {
    expect(housingMonthOptions('2026-11')).toEqual(['2026-09', '2026-10', '2026-11', '2026-12']);
    expect(housingMonthOptions('2026-12').slice(-2)).toEqual(['2026-12', '2027-01']);
  });

  it('жил хоть день в месяце: въезд до следующего месяца, выезд позже 1-го', () => {
    expect(touchesMonth({ check_in: '2026-09-01', check_out: null }, '2026-11')).toBe(true);
    expect(touchesMonth({ check_in: '2026-11-30', check_out: null }, '2026-11')).toBe(true);
    expect(touchesMonth({ check_in: '2026-12-01', check_out: null }, '2026-11')).toBe(false);
    expect(touchesMonth({ check_in: '2026-09-01', check_out: '2026-11-02' }, '2026-11')).toBe(true);
    expect(touchesMonth({ check_in: '2026-09-01', check_out: '2026-11-01' }, '2026-11')).toBe(false);
  });

  it('история общежития — с комментарием записи', () => {
    expect(DORMITORY_HISTORY_COLUMNS.map(column => column.label)).toEqual(
      ['Сотрудник', 'Подразделение', 'Общежитие', 'Дата въезда', 'Дата выезда', 'Комментарий'],
    );
  });
});
