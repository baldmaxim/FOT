import { describe, it, expect, vi, beforeEach } from 'vitest';

const { pgQuery } = vi.hoisted(() => ({ pgQuery: vi.fn() }));

vi.mock('../config/postgres.js', async (importActual) => ({
  ...(await importActual<typeof import('../config/postgres.js')>()),
  query: pgQuery,
}));

import {
  classifyOwnership,
  enumerateDatesInclusive,
  loadOwnershipIntervals,
  ownershipKey,
  ownsDay,
  resolveDayOwnership,
  type IOwnershipInterval,
} from './timesheet-day-ownership.service.js';

const OLD_APPROVAL = 1551; // бр.Каримов О.М.
const NEW_APPROVAL = 1428; // бр.Эрматова М.М.

/** Интервал назначения: [from, to] + подачи, чей отдел его накрывает. */
const interval = (
  effectiveFrom: string,
  effectiveTo: string | null,
  owningApprovalIds: number[],
): IOwnershipInterval => ({ effectiveFrom, effectiveTo, owningApprovalIds });

beforeEach(() => {
  pgQuery.mockReset();
  pgQuery.mockResolvedValue([]);
});

describe('classifyOwnership', () => {
  it('перевод внутри периода: до даты перевода владеет старая подача, с даты — новая', () => {
    // Кейс Ибрагимова: бр.Каримов до 24.08, бр.Эрматова с 25.08.
    const intervals = [
      interval('2026-07-30', '2026-08-24', [OLD_APPROVAL]),
      interval('2026-08-25', null, [NEW_APPROVAL]),
    ];

    expect(classifyOwnership(intervals, OLD_APPROVAL, '2026-08-24')).toBe('owned');
    expect(classifyOwnership(intervals, OLD_APPROVAL, '2026-08-25')).toBe('not_owned');
    expect(classifyOwnership(intervals, OLD_APPROVAL, '2026-08-30')).toBe('not_owned');
    expect(classifyOwnership(intervals, NEW_APPROVAL, '2026-08-30')).toBe('owned');
    expect(classifyOwnership(intervals, NEW_APPROVAL, '2026-08-24')).toBe('not_owned');
  });

  it('перевод ровно в первый день подачи: все дни периода not_owned, а не unknown', () => {
    // Старое назначение закрыто 15.08 и в выборку периода 16–31 не попадает —
    // важно, чтобы это не выглядело как «истории нет» и не включало snapshot-fallback.
    const intervals = [interval('2026-08-16', null, [NEW_APPROVAL])];

    for (const date of enumerateDatesInclusive('2026-08-16', '2026-08-31')) {
      expect(classifyOwnership(intervals, OLD_APPROVAL, date)).toBe('not_owned');
    }
  });

  it('уход и возврат в ту же бригаду: два интервала владения, промежуток чужой', () => {
    const intervals = [
      interval('2026-08-01', '2026-08-10', [OLD_APPROVAL]),
      interval('2026-08-11', '2026-08-20', [NEW_APPROVAL]),
      interval('2026-08-21', null, [OLD_APPROVAL]),
    ];

    expect(classifyOwnership(intervals, OLD_APPROVAL, '2026-08-05')).toBe('owned');
    expect(classifyOwnership(intervals, OLD_APPROVAL, '2026-08-15')).toBe('not_owned');
    expect(classifyOwnership(intervals, OLD_APPROVAL, '2026-08-25')).toBe('owned');
  });

  it('перевод, затем смена должности в новом отделе: цепочка не ломает владение', () => {
    const intervals = [
      interval('2026-07-30', '2026-08-24', [OLD_APPROVAL]),
      interval('2026-08-25', '2026-08-27', [NEW_APPROVAL]),
      interval('2026-08-28', null, [NEW_APPROVAL]),
    ];

    expect(classifyOwnership(intervals, NEW_APPROVAL, '2026-08-26')).toBe('owned');
    expect(classifyOwnership(intervals, NEW_APPROVAL, '2026-08-29')).toBe('owned');
    expect(classifyOwnership(intervals, OLD_APPROVAL, '2026-08-29')).toBe('not_owned');
  });

  it('смена должности без смены отдела: владение не меняется', () => {
    const intervals = [
      interval('2026-08-01', '2026-08-19', [OLD_APPROVAL]),
      interval('2026-08-20', null, [OLD_APPROVAL]),
    ];

    for (const date of ['2026-08-10', '2026-08-20', '2026-08-31']) {
      expect(classifyOwnership(intervals, OLD_APPROVAL, date)).toBe('owned');
    }
  });

  it('freeze-артефакт с поздним effective_from: ранние даты unknown, поздние owned', () => {
    // Единственное назначение, начатое позже реального выхода в отдел: ранние даты
    // не покрыты историей, и владение должно решаться снимком, а не отказом.
    const intervals = [interval('2026-08-20', null, [OLD_APPROVAL])];

    expect(classifyOwnership(intervals, OLD_APPROVAL, '2026-08-17')).toBe('unknown');
    expect(classifyOwnership(intervals, OLD_APPROVAL, '2026-08-25')).toBe('owned');
  });

  it('истории назначений нет вовсе: unknown на любую дату', () => {
    expect(classifyOwnership(undefined, OLD_APPROVAL, '2026-08-30')).toBe('unknown');
    expect(classifyOwnership([], OLD_APPROVAL, '2026-08-30')).toBe('unknown');
  });

  it('unknown трактуется как владение, not_owned — нет', () => {
    expect(ownsDay('owned')).toBe(true);
    expect(ownsDay('unknown')).toBe(true);
    expect(ownsDay(undefined)).toBe(true);
    expect(ownsDay('not_owned')).toBe(false);
  });
});

describe('resolveDayOwnership', () => {
  it('персональная подача всегда unknown и в SQL по отделу не участвует', async () => {
    const ownership = await resolveDayOwnership(
      [{ approvalId: 256, departmentId: null, employeeIds: [661], dates: ['2026-08-30'] }],
      undefined,
    );

    expect(ownership.get(ownershipKey(256, 661, '2026-08-30'))).toBe('unknown');
    const [, , , approvalIds, departmentIds] = pgQuery.mock.calls[0][1] as unknown[][];
    expect(approvalIds).toEqual([]);
    expect(departmentIds).toEqual([]);
  });

  it('раскладывает состояния по (подача, сотрудник, дата)', async () => {
    pgQuery.mockResolvedValue([
      {
        employee_id: 661,
        effective_from: '2026-07-30',
        effective_to: '2026-08-24',
        owning_approval_ids: [OLD_APPROVAL],
      },
      {
        employee_id: 661,
        effective_from: '2026-08-25',
        effective_to: null,
        owning_approval_ids: [NEW_APPROVAL],
      },
    ]);

    const ownership = await resolveDayOwnership(
      [
        {
          approvalId: OLD_APPROVAL,
          departmentId: 'e443116c-62f3-4b08-870f-4f7e9f52c662',
          employeeIds: [661],
          dates: ['2026-08-20', '2026-08-30'],
        },
        {
          approvalId: NEW_APPROVAL,
          departmentId: '7f9e3439-6e84-440a-902c-e2b8003f49d2',
          employeeIds: [661],
          dates: ['2026-08-20', '2026-08-30'],
        },
      ],
      undefined,
    );

    expect(ownership.get(ownershipKey(OLD_APPROVAL, 661, '2026-08-20'))).toBe('owned');
    expect(ownership.get(ownershipKey(OLD_APPROVAL, 661, '2026-08-30'))).toBe('not_owned');
    expect(ownership.get(ownershipKey(NEW_APPROVAL, 661, '2026-08-20'))).toBe('not_owned');
    expect(ownership.get(ownershipKey(NEW_APPROVAL, 661, '2026-08-30'))).toBe('owned');
    // Один поход в БД на весь набор подач — вызывается из-под advisory-локов.
    expect(pgQuery).toHaveBeenCalledTimes(1);
  });

  it('пустой набор не ходит в БД', async () => {
    const ownership = await resolveDayOwnership([], undefined);
    expect(ownership.size).toBe(0);
    expect(pgQuery).not.toHaveBeenCalled();
  });
});

describe('loadOwnershipIntervals', () => {
  it('внутри транзакции читает через переданный exec, а не через пул', async () => {
    const exec = { query: vi.fn().mockResolvedValue({ rows: [] }) };

    await loadOwnershipIntervals(
      [661],
      '2026-08-16',
      '2026-08-31',
      [{ approvalId: OLD_APPROVAL, departmentId: 'e443116c-62f3-4b08-870f-4f7e9f52c662' }],
      exec as never,
    );

    expect(exec.query).toHaveBeenCalledTimes(1);
    expect(pgQuery).not.toHaveBeenCalled();
  });

  it('назначение в папку «Уволенные» не считается доказательством', async () => {
    // При увольнении freeze-режим переписывает открытую строку, сохраняя старую
    // effective_from: весь предыдущий период уволенного «числится» в архиве.
    // Если считать это доказательством, реально отработанные дни вырежутся из версии.
    const exec = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    await loadOwnershipIntervals([13], '2026-05-01', '2026-05-15', [], exec as never);

    const sql = exec.query.mock.calls[0][0] as string;
    expect(sql).toContain("s.key = 'employees_archive_department_id'");
    expect(sql).toMatch(/WHERE NOT EXISTS \(\s*SELECT 1 FROM chain c\s*JOIN archive ar/);
  });

  it('поднимается по дереву отделов и не схлопывает интервалы', async () => {
    const exec = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    await loadOwnershipIntervals([661], '2026-08-16', '2026-08-31', [], exec as never);

    const sql = exec.query.mock.calls[0][0] as string;
    expect(sql).toMatch(/JOIN org_departments d ON d\.id = c\.parent_id/);
    expect(sql).toMatch(/c\.depth < \d+/);
    expect(sql).toContain('FROM employee_assignments ea');
    // Никаких GROUP BY по сотруднику: каждая строка назначений остаётся отдельным интервалом.
    expect(sql).not.toContain('GROUP BY a.employee_id');
  });
});

describe('enumerateDatesInclusive', () => {
  it('перечисляет даты включительно и переходит через границу месяца', () => {
    expect(enumerateDatesInclusive('2026-08-30', '2026-09-01'))
      .toEqual(['2026-08-30', '2026-08-31', '2026-09-01']);
    expect(enumerateDatesInclusive('2026-08-30', '2026-08-30')).toEqual(['2026-08-30']);
    expect(enumerateDatesInclusive('2026-08-30', '2026-08-29')).toEqual([]);
  });
});
