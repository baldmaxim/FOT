import { describe, it, expect, vi } from 'vitest';

vi.mock('./access-control.service.js', () => ({ getRolePageAccess: vi.fn(async () => ({})) }));
vi.mock('./timesheet-version.service.js', () => ({ loadClosedTimesheetLocks: vi.fn(async () => new Map()) }));

import { cardVersion, groupVisibleDays, type IVisibleLeaveDay } from './correction-leave.service.js';
import { earliestDatePerMonth, rejectLockPairs } from './correction-leave-decisions.service.js';
import { buildNotificationDrafts } from './correction-leave-reconcile.service.js';
import { formatLeaveDays, shortFio } from '../utils/correction-leave-format.js';

// Отпуск корректировкой (миграция 311): чистые части — карточки, версия, тексты, локи отказа.

const day = (over: Partial<IVisibleLeaveDay> & { adjustment_id: number; work_date: string }): IVisibleLeaveDay => ({
  employee_id: 562,
  status: 'vacation',
  author_id: 'author-1',
  reason: 'отпуск',
  files_sig: '',
  series_start: over.work_date,
  updated_at: '2026-10-08T08:45:31.000Z',
  ...over,
});

describe('groupVisibleDays / cardVersion', () => {
  it('серии из SQL → карточки; несмежные даты — разные карточки', () => {
    const cards = groupVisibleDays([
      day({ adjustment_id: 1, work_date: '2026-10-15', series_start: '2026-10-15' }),
      day({ adjustment_id: 2, work_date: '2026-10-16', series_start: '2026-10-15', files_sig: '7' }),
      day({ adjustment_id: 3, work_date: '2026-10-20', series_start: '2026-10-20' }),
    ]);
    expect(cards.map(c => [c.key, c.days, c.adjustment_ids])).toEqual([
      ['562:2026-10-15', ['2026-10-15', '2026-10-16'], [1, 2]],
      ['562:2026-10-20', ['2026-10-20'], [3]],
    ]);
    expect(cards[0]!.file_ids).toEqual([7]);
  });

  it('версия не зависит от updated_at, но меняется от типа и файлов', () => {
    const base = [day({ adjustment_id: 1, work_date: '2026-10-15' })];
    const resaved = [day({ adjustment_id: 1, work_date: '2026-10-15', updated_at: '2026-10-09T00:00:00.000Z' })];
    expect(cardVersion(resaved)).toBe(cardVersion(base));
    expect(cardVersion([day({ adjustment_id: 1, work_date: '2026-10-15', status: 'unpaid' })])).not.toBe(cardVersion(base));
    expect(cardVersion([day({ adjustment_id: 1, work_date: '2026-10-15', files_sig: '15650' })])).not.toBe(cardVersion(base));
  });
});

describe('отказ: локи и хвостовой пересчёт', () => {
  it('квотные локи захватывают соседние дни, в т.ч. в соседних месяцах', () => {
    const pairs = rejectLockPairs({
      employee_id: 562,
      start_date: '2026-10-01',
      end_date: '2026-10-31',
      days: ['2026-10-01', '2026-10-31'],
    });
    expect(pairs.map(p => p.workDate)).toEqual(['2026-09-30', '2026-10-01', '2026-10-31', '2026-11-01']);
  });

  it('пересчёт хвоста — с самой ранней удалённой даты каждого месяца', () => {
    expect(earliestDatePerMonth(['2026-10-02', '2026-09-28', '2026-10-01', '2026-09-30'])).toEqual(['2026-09-28', '2026-10-01']);
  });
});

describe('тексты уведомлений', () => {
  it('ФИО кратко и даты диапазонами', () => {
    expect(shortFio('Тихонович Юрий Викторович')).toBe('Тихонович Ю.В.');
    expect(formatLeaveDays(['2026-10-16', '2026-10-15', '2026-10-17', '2026-10-20'])).toBe('15.10–17.10, 20.10.2026');
  });

  it('одно уведомление на группу событий; снятие — с видом снятия', () => {
    const names = {
      employees: new Map<number, string | null>([[562, 'Дульянинов Владислав Игоревич']]),
      profiles: new Map<string, string | null>([['author-1', 'Тихонович Юрий Викторович']]),
    };
    const drafts = buildNotificationDrafts([
      { kind: 'added', employeeId: 562, status: 'vacation', authorId: 'author-1', workDate: '2026-10-15' },
      { kind: 'added', employeeId: 562, status: 'vacation', authorId: 'author-1', workDate: '2026-10-16' },
      { kind: 'removed', employeeId: 562, status: 'vacation', authorId: 'author-1', workDate: '2026-10-20', removedKind: 'deleted' },
    ], names);
    expect(drafts.map(d => [d.title, d.body])).toEqual([
      ['Отпуск корректировкой табеля', 'Отпуск: Дульянинов В.И., 15.10–16.10.2026. Автор корректировки: Тихонович Ю.В.'],
      ['Снят ознакомленный отпуск', 'Отпуск: Дульянинов В.И., 20.10.2026 — удалён из табеля.'],
    ]);
  });
});
