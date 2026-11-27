import { describe, expect, it } from 'vitest';

import { teamSalaryKeys } from '../api/queryKeys';
import type { ITeamSalaryResponse, TeamSalaryRow } from '../services/teamSalaryService';
import {
  isTeamSalaryExpired,
  resolveTeamSalaryView,
  msUntilNextMonth,
  teamSalaryCellText,
  teamSalaryClockOffset,
  teamSalaryColumnTitle,
  teamSalaryHeader,
  teamSalaryMonthName,
  teamSalaryReasonText,
} from './teamSalary';

const ready: TeamSalaryRow = {
  employee_id: 1,
  status: 'ready',
  net: '139942.00',
  calc: {
    state: 'closed', period_from: '2026-10-01', period_to: '2026-10-31', norm_days: 23,
    worked_days: { workday: 16, dayoff: 0 }, absences: { vacation: 0, sick: 0, educational_leave: 0, unpaid: 0 },
    lines: [], deductions: [], accrued: '139942.00', deducted: '0.00', net: '139942.00', missing: [],
  },
};

describe('подписи столбца', () => {
  it('заголовок и название месяца', () => {
    expect(teamSalaryHeader('2026-10')).toBe('Зарплата · окт.');
    expect(teamSalaryHeader('2026-05')).toBe('Зарплата · май');
    expect(teamSalaryMonthName('2026-12')).toBe('декабрь 2026');
  });

  it('подсказка: месяц, без НДФЛ, когда следующий — по МСК, через год', () => {
    expect(teamSalaryColumnTitle({ month: '2026-10', next_from: '2026-12-09T21:00:00.000Z' }))
      .toBe('Зарплата за октябрь 2026 — к выплате, без НДФЛ. За ноябрь — с 10.12');
    expect(teamSalaryColumnTitle({ month: '2026-12', next_from: '2027-02-09T21:00:00.000Z' }))
      .toBe('Зарплата за декабрь 2026 — к выплате, без НДФЛ. За январь — с 10.02');
  });

  it('сумма — только у готовой строки', () => {
    expect(teamSalaryCellText(ready)).toBe(new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2 }).format(139942));
    expect(teamSalaryCellText({ employee_id: 1, status: 'not_ready', missing: ['sick_pay'] })).toBe('—');
    expect(teamSalaryCellText(undefined)).toBe('—');
  });
});

describe('причины «—» — на каждый код', () => {
  const reason = (row: TeamSalaryRow) => teamSalaryReasonText(row, '2026-10');

  it('незакрытый расчёт', () => {
    expect(reason({ employee_id: 1, status: 'not_closed', reason: 'not_covered' })).toBe('Табель за октябрь не закрыт');
    expect(reason({ employee_id: 1, status: 'not_closed', reason: 'norm_conflict' }))
      .toBe('Расчёт за октябрь не готов: расходятся нормы графика');
    expect(reason({ employee_id: 1, status: 'not_closed', reason: 'no_period' })).toBe('В октябре не было периода работы');
    expect(reason({ employee_id: 1, status: 'not_closed', reason: 'brigade_open' }))
      .toBe('Расчёт бригады за октябрь не закрыт');
  });

  it('неполная сумма — чего не хватает', () => {
    expect(reason({ employee_id: 1, status: 'not_ready', missing: ['sick_pay', 'vacation_pay'] }))
      .toBe('Сумма за октябрь неполная (без: больничные, отпускные)');
    expect(reason({ employee_id: 1, status: 'not_ready', missing: [] })).toBe('Сумма за октябрь ещё не готова');
  });

  it('у готовой строки причины нет', () => {
    expect(reason(ready)).toBeNull();
  });
});

describe('смена месяца 10-го числа', () => {
  const NEXT = '2026-12-09T21:00:00.000Z';

  it('сдвиг часов: клиент отстаёт на минуту — граница по часам сервера', () => {
    const receivedAt = Date.parse('2026-12-09T20:00:00.000Z');
    const offset = teamSalaryClockOffset('2026-12-09T20:01:00.000Z', receivedAt);
    expect(offset).toBe(60_000);
    expect(msUntilNextMonth(NEXT, offset, receivedAt)).toBe(59 * 60_000);
    expect(msUntilNextMonth(NEXT, offset, Date.parse('2026-12-09T20:59:00.000Z'))).toBe(0);
    expect(msUntilNextMonth(NEXT, 0, Date.parse('2026-12-09T21:00:01.000Z'))).toBe(-1000);
  });

  it('ответ, отправленный после полуночи МСК 10-го, истёк — суммы не показываются', () => {
    expect(isTeamSalaryExpired({ next_from: NEXT, server_now: '2026-12-09T20:59:59.999Z' })).toBe(false);
    expect(isTeamSalaryExpired({ next_from: NEXT, server_now: '2026-12-09T21:00:00.000Z' })).toBe(true);
    expect(isTeamSalaryExpired({ next_from: NEXT, server_now: '2026-12-09T21:00:05.000Z' })).toBe(true);
  });
});

describe('что показывать: после ошибки и истёкшего ответа сумм нет', () => {
  const data: ITeamSalaryResponse = {
    month: '2026-10',
    next_from: '2026-12-09T21:00:00.000Z',
    server_now: '2026-11-27T09:00:00.000Z',
    rows: [ready],
  };

  it('ответ есть — суммы и столбец', () => {
    expect(resolveTeamSalaryView({ active: true, isError: false, refused: false, data }))
      .toEqual({ visible: true, loading: false, data, failed: false });
  });

  it('новая эпоха доступа или учётка — ключ другой, данных нет: «…» до ответа сервера', () => {
    expect(teamSalaryKeys.byDepartment('p1', 1, 'd1')).not.toEqual(teamSalaryKeys.byDepartment('p1', 2, 'd1'));
    expect(teamSalaryKeys.byDepartment('p1', 1, 'd1')).not.toEqual(teamSalaryKeys.byDepartment('p2', 1, 'd1'));
    expect(teamSalaryKeys.byDepartment('p1', 1, 'd1').slice(0, 1)).toEqual(teamSalaryKeys.all);
    expect(resolveTeamSalaryView({ active: true, isError: false, refused: false, data: undefined }))
      .toEqual({ visible: true, loading: true, data: undefined, failed: false });
  });

  it('снят отдел — 403 при прежних данных у запроса: столбца нет, суммы скрыты; другой отдел — по своему ключу', () => {
    expect(resolveTeamSalaryView({ active: true, isError: true, refused: true, data }))
      .toEqual({ visible: false, loading: false, data: undefined, failed: false });
    expect(resolveTeamSalaryView({ active: true, isError: false, refused: false, data }).data).toBe(data);
  });

  it('сбой сервера — столбец остаётся, суммы скрыты', () => {
    expect(resolveTeamSalaryView({ active: true, isError: true, refused: false, data }))
      .toEqual({ visible: true, loading: false, data: undefined, failed: true });
  });

  it('ответ истёк на сервере — как ещё не пришедший', () => {
    const late = { ...data, server_now: '2026-12-09T21:00:01.000Z' };
    expect(resolveTeamSalaryView({ active: true, isError: false, refused: false, data: late }))
      .toEqual({ visible: true, loading: true, data: undefined, failed: false });
  });

  it('доступа нет (флаг профиля снят) — ничего', () => {
    expect(resolveTeamSalaryView({ active: false, isError: false, refused: false, data }))
      .toEqual({ visible: false, loading: false, data: undefined, failed: false });
  });
});
