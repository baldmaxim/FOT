import { describe, expect, it } from 'vitest';

import type { ICompensationMonthRow, IDormitoryStay } from '../services/dormitoryService';
import {
  APARTMENT_ARCHIVE_COLUMNS,
  apartmentTitle,
  buildCompensationExport,
  closedInMonth,
  COMPENSATION_ARCHIVE_COLUMNS,
  COMPENSATION_COLUMNS,
  compensationArchiveRows,
  compensationTone,
  compensationTotals,
  dismissedTone,
  DORMITORY_ARCHIVE_COLUMNS,
  DORMITORY_DIRECTORY_COLUMNS,
  formatPassTime,
  formatPeriod,
  housingBackPath,
  housingMonthOptions,
  livesOn,
  readHousingReturn,
  stripHousingReturn,
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

  it('архив общежития — с комментарием записи', () => {
    expect(DORMITORY_ARCHIVE_COLUMNS.map(column => column.label)).toEqual(
      ['Сотрудник', 'Подразделение', 'Общежитие', 'Дата въезда', 'Дата выезда', 'Комментарий'],
    );
  });
});

describe('«Проживание»: архив за месяц, «Возобновлена» убрана, возврат из карточки (24.11.2026)', () => {
  it('архив месяца — выезд с 1-го числа по конец месяца и не позже сегодня', () => {
    const today = '2026-11-24';
    expect(closedInMonth({ check_out: '2026-11-01' }, '2026-11', today)).toBe(true);
    expect(closedInMonth({ check_out: '2026-11-24' }, '2026-11', today)).toBe(true);
    // Выезд назначен на завтра — ещё не архив.
    expect(closedInMonth({ check_out: '2026-11-25' }, '2026-11', today)).toBe(false);
    expect(closedInMonth({ check_out: '2026-10-31' }, '2026-11', today)).toBe(false);
    expect(closedInMonth({ check_out: '2026-10-31' }, '2026-10', today)).toBe(true);
    expect(closedInMonth({ check_out: null }, '2026-11', today)).toBe(false);
    // Будущий месяц — пусто.
    expect(closedInMonth({ check_out: '2026-12-01' }, '2026-12', today)).toBe(false);
  });

  it('«Компенсация аренды» — без «Возобновлена» и на экране, и в xlsx', () => {
    expect(COMPENSATION_COLUMNS.map(column => column.label)).not.toContain('Возобновлена');
    expect(buildCompensationExport('Ноябрь 2026')([]).columns.map(column => column.label)).not.toContain('Возобновлена');
  });

  it('архив компенсации: закончившиеся в месяце без приостановленных; начало — первой записи цепочки', () => {
    const paused = stay({ id: 10, kind: 'apartment', check_in: '2026-09-01', check_out: '2026-10-10', suspended: true });
    const resumed = stay({ id: 11, kind: 'apartment', check_in: '2026-10-20', check_out: '2026-11-15', resumed_from_id: 10 });
    const pausedNow = stay({ id: 12, kind: 'apartment', check_in: '2026-09-01', check_out: '2026-11-05', suspended: true });
    const dormitory = stay({ id: 13, check_out: '2026-11-03' });
    const rows = compensationArchiveRows([paused, resumed, pausedNow, dormitory], '2026-11', '2026-11-24');
    expect(rows.map(row => [row.id, row.compensation_start])).toEqual([[11, '2026-09-01']]);
    expect(COMPENSATION_ARCHIVE_COLUMNS.find(column => column.key === 'check_in')!.text(rows[0])).toBe('01.09.2026');
    expect(APARTMENT_ARCHIVE_COLUMNS.map(column => column.label)).toEqual(
      ['Сотрудник', 'Подразделение', 'Квартира', 'Дата въезда', 'Дата выезда', 'Комментарий'],
    );
  });

  it('адрес возврата: вкладка, месяц, окно квартиры — читается один раз и убирается, чужие параметры целы', () => {
    const path = housingBackPath('apartment', '2026-11', 7);
    expect(path).toBe('/staff-control?tab=dormitory&housing=apartment&month=2026-11&apartment=7');
    const params = new URLSearchParams(path.split('?')[1]);
    expect(readHousingReturn(params)).toEqual({ housing: 'apartment', month: '2026-11', apartment: 7 });
    expect(readHousingReturn(new URLSearchParams('tab=roster&housing=dormitory'))).toEqual({ housing: null, month: null, apartment: null });
    expect(readHousingReturn(new URLSearchParams('tab=dormitory&apartment=abc')).apartment).toBeNull();

    params.set('q', 'Иванов');
    expect(stripHousingReturn(params)?.toString()).toBe('q=%D0%98%D0%B2%D0%B0%D0%BD%D0%BE%D0%B2');
    expect(stripHousingReturn(new URLSearchParams('q=1'))).toBeNull();
  });
});

describe('справочник общежитий (377)', () => {
  const svobody = { id: 3, address: 'Общ. Свободы 35', doc_date: '2025-09-22', doc_number: '000000009', place_price: '550.00' };
  const texts = (row: typeof svobody | { id: number; address: string; doc_date: null; doc_number: null; place_price: null }) => (
    DORMITORY_DIRECTORY_COLUMNS.map(column => column.text(row))
  );

  it('столбцы как в 1С: Дата, Номер, Общежитие, Стоимость места; пустое — прочерк', () => {
    expect(DORMITORY_DIRECTORY_COLUMNS.map(column => column.label)).toEqual(['Дата', 'Номер', 'Общежитие', 'Стоимость места']);
    expect(texts(svobody)[0]).toBe('22.09.2025');
    expect(texts(svobody)[1]).toBe('000000009');
    expect(texts(svobody)[2]).toBe('Общ. Свободы 35');
    expect(texts(svobody)[3]).toMatch(/^550,00/);
    expect(texts({ id: 1, address: 'Общ. База Мытищи', doc_date: null, doc_number: null, place_price: null }))
      .toEqual(['—', '—', 'Общ. База Мытищи', '—']);
  });
});
