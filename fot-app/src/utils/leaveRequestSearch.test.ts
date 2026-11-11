import { describe, expect, it } from 'vitest';

import type { ILeaveRequest } from '../services/leaveRequestService';
import { matchesLeaveRequestSearch } from './leaveRequestSearch';

const request = (over: Partial<ILeaveRequest> = {}): ILeaveRequest => ({
  id: 1,
  employee_id: 1,
  request_type: 'vacation',
  status: 'approved',
  start_date: '2026-06-10',
  end_date: '2026-06-20',
  reason: null,
  reviewer_id: null,
  reviewed_at: null,
  review_comment: null,
  correction_date: null,
  correction_status: null,
  correction_hours: null,
  selected_dates: null,
  created_at: '2026-06-01T10:00:00Z',
  updated_at: '2026-06-01T10:00:00Z',
  ...over,
});

describe('matchesLeaveRequestSearch', () => {
  it('пустой запрос — подходит всё', () => {
    expect(matchesLeaveRequestSearch(request(), '')).toBe(true);
    expect(matchesLeaveRequestSearch(request(), '   ')).toBe(true);
  });

  it('день внутри диапазона находит многодневное заявление', () => {
    const r = request();
    expect(matchesLeaveRequestSearch(r, '14.06')).toBe(true);
    expect(matchesLeaveRequestSearch(r, '14.06.2026')).toBe(true);
    expect(matchesLeaveRequestSearch(r, '21.06')).toBe(false);
    expect(matchesLeaveRequestSearch(r, '14.06.2025')).toBe(false);
  });

  it('месяц находит заявление, перекрывающее месяц', () => {
    const r = request({ start_date: '2026-06-27', end_date: '2026-07-05' });
    expect(matchesLeaveRequestSearch(r, '07.2026')).toBe(true);
    expect(matchesLeaveRequestSearch(r, '06.2026')).toBe(true);
    expect(matchesLeaveRequestSearch(r, '08.2026')).toBe(false);
  });

  it('набор дат — только выбранные дни, не промежуток между ними', () => {
    const r = request({
      request_type: 'work',
      start_date: '2026-06-13',
      end_date: '2026-06-20',
      selected_dates: ['2026-06-13', '2026-06-20'],
    });
    expect(matchesLeaveRequestSearch(r, '20.06')).toBe(true);
    expect(matchesLeaveRequestSearch(r, '14.06')).toBe(false);
  });

  it('корректировка ищется по дню корректировки и статусу', () => {
    const r = request({
      request_type: 'time_correction',
      start_date: '2026-11-03',
      end_date: '2026-11-03',
      correction_date: '2026-11-03',
      correction_status: 'work',
    });
    expect(matchesLeaveRequestSearch(r, '03.11')).toBe(true);
    expect(matchesLeaveRequestSearch(r, 'рабочий день')).toBe(true);
    expect(matchesLeaveRequestSearch(r, 'корректировка')).toBe(true);
  });

  it('тип, статус, причина и комментарий; все слова запроса обязательны', () => {
    const r = request({
      status: 'cancelled',
      cancel_source: 'employee',
      cancel_reason: 'Перенёс на август',
      reason: 'Семейные обстоятельства',
    });
    expect(matchesLeaveRequestSearch(r, 'отпуск 14.06')).toBe(true);
    expect(matchesLeaveRequestSearch(r, 'отменено сотрудником')).toBe(true);
    expect(matchesLeaveRequestSearch(r, 'семейные')).toBe(true);
    expect(matchesLeaveRequestSearch(r, 'перенес')).toBe(true);
    expect(matchesLeaveRequestSearch(r, 'ОТПУСК')).toBe(true);
    expect(matchesLeaveRequestSearch(r, 'отпуск 21.06')).toBe(false);
    expect(matchesLeaveRequestSearch(r, 'больничный')).toBe(false);
  });

  it('легаси-год в диапазоне не роняет поиск', () => {
    const r = request({ start_date: '2026-06-10', end_date: '+062026-06-20' });
    expect(matchesLeaveRequestSearch(r, '10.06.2026')).toBe(true);
    expect(matchesLeaveRequestSearch(r, 'отпуск')).toBe(true);
  });
});
