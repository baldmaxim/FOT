import { beforeEach, describe, expect, it, vi } from 'vitest';

const { pgQuery, pgQueryOne } = vi.hoisted(() => ({
  pgQuery: vi.fn(),
  pgQueryOne: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  query: pgQuery,
  queryOne: pgQueryOne,
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));

import {
  assertCorrectionAllowed,
  assertBulkAllowed,
  assertBulkCorrectionAllowed,
  assertDayCorrectionsWithinCap,
  assertObjectCorrectionsAllowed,
  CorrectionRestrictionError,
  invalidateCorrectionRestrictionsCache,
} from './correction-restrictions.service.js';

interface IRoleRow {
  corrections_anomalies_only: boolean;
  corrections_cap_by_schedule_norm: boolean;
  corrections_allow_zero_short_attendance: boolean;
  corrections_disable_bulk: boolean;
  corrections_disable_object_entries: boolean;
  max_corrections_per_month: number | null;
}

const ROLE_OFF: IRoleRow = {
  corrections_anomalies_only: false,
  corrections_cap_by_schedule_norm: false,
  corrections_allow_zero_short_attendance: false,
  corrections_disable_bulk: false,
  corrections_disable_object_entries: false,
  max_corrections_per_month: null,
};

const ROLE_SITE_SUPERVISOR: IRoleRow = {
  corrections_anomalies_only: true,
  corrections_cap_by_schedule_norm: true,
  corrections_allow_zero_short_attendance: true,
  corrections_disable_bulk: true,
  corrections_disable_object_entries: true,
  max_corrections_per_month: null,
};

/**
 * Стабит queryOne как stateful маршрутизатор по тексту SQL.
 *  - SELECT corrections_* FROM system_roles    → строка ограничений роли
 *  - SELECT public.is_skud_anomalous_day ...   → { anomalous: <bool> }
 *  - SELECT total_minutes FROM skud_daily_summary → { total_minutes: <num|null> }
 *  - SELECT COUNT(*) FROM attendance_adjustments → { cnt: <num> }
 */
function setupQueryOne(opts: {
  restrictions: IRoleRow;
  anomalous: boolean;
  totalMinutes: number | null;
  monthCount: number;
}) {
  pgQueryOne.mockImplementation(async (sql: string) => {
    if (/FROM\s+system_roles/i.test(sql)) return opts.restrictions;
    if (/is_skud_anomalous_day/.test(sql)) return { anomalous: opts.anomalous };
    if (/FROM\s+skud_daily_summary/i.test(sql)) return { total_minutes: opts.totalMinutes };
    if (/FROM\s+attendance_adjustments/i.test(sql)) return { cnt: opts.monthCount };
    return null;
  });
}

const BASE = {
  systemRoleId: '00000000-0000-0000-0000-000000000001',
  createdBy: '00000000-0000-0000-0000-000000000aaa',
  employeeId: 42,
  workDate: '2026-05-12',
  correctionCapHours: 8,
  capHoursToCheck: null as number | null,
};

describe('correction-restrictions.service', () => {
  beforeEach(() => {
    pgQuery.mockReset();
    pgQueryOne.mockReset();
    invalidateCorrectionRestrictionsCache();
  });

  it('пропускает корректировку, когда все флаги выключены', async () => {
    setupQueryOne({ restrictions: ROLE_OFF, anomalous: false, totalMinutes: 100, monthCount: 0 });
    await expect(assertCorrectionAllowed({
      ...BASE,
      hoursOverride: 8,
      scheduledNormHours: 8,
    })).resolves.toBeUndefined();
  });

  it('блокирует hours>0 в неаномальный день при anomalies_only=true', async () => {
    setupQueryOne({ restrictions: ROLE_SITE_SUPERVISOR, anomalous: false, totalMinutes: 0, monthCount: 0 });
    await expect(assertCorrectionAllowed({
      ...BASE,
      hoursOverride: 8,
      scheduledNormHours: 8,
    })).rejects.toMatchObject({ code: 'not_anomalous' });
  });

  it('блокирует hours > план дня при cap_by_schedule_norm=true', async () => {
    setupQueryOne({ restrictions: ROLE_SITE_SUPERVISOR, anomalous: true, totalMinutes: 0, monthCount: 0 });
    await expect(assertCorrectionAllowed({
      ...BASE,
      hoursOverride: 10,
      scheduledNormHours: 8,
      capHoursToCheck: 10,
    })).rejects.toMatchObject({ code: 'hours_exceed_norm' });
  });

  it('skipAnomalyCheck: удалёнка поверх согласованного выхода в выходной (норма 0) — до длины смены', async () => {
    setupQueryOne({ restrictions: ROLE_SITE_SUPERVISOR, anomalous: false, totalMinutes: 0, monthCount: 0 });
    await expect(assertCorrectionAllowed({
      ...BASE,
      hoursOverride: 10,
      scheduledNormHours: 0, // выходной
      correctionCapHours: 10,
      capHoursToCheck: 10,
      skipAnomalyCheck: true,
    })).resolves.toBeUndefined();
  });

  it('skipAnomalyCheck не снимает предел: 11 ч при смене 10 ч → hours_exceed_norm', async () => {
    setupQueryOne({ restrictions: ROLE_SITE_SUPERVISOR, anomalous: false, totalMinutes: 0, monthCount: 0 });
    await expect(assertCorrectionAllowed({
      ...BASE,
      hoursOverride: 11,
      scheduledNormHours: 0,
      correctionCapHours: 10,
      capHoursToCheck: 11,
      skipAnomalyCheck: true,
    })).rejects.toMatchObject({ code: 'hours_exceed_norm', details: { correctionCapHours: 10 } });
  });

  it('норма и предел независимы: на выходном аномалия проверяется с scheduled=false, хотя предел 10', async () => {
    setupQueryOne({ restrictions: ROLE_SITE_SUPERVISOR, anomalous: true, totalMinutes: 0, monthCount: 0 });
    await assertCorrectionAllowed({
      ...BASE,
      hoursOverride: 10,
      scheduledNormHours: 0,
      correctionCapHours: 10,
      capHoursToCheck: 10,
    });
    const anomalyCall = pgQueryOne.mock.calls.find(call => /is_skud_anomalous_day/.test(String(call[0])));
    expect(anomalyCall?.[1]).toEqual([BASE.employeeId, BASE.workDate, false]);
  });

  it('capHoursToCheck=null: неизменная правка 14 ч при пределе 12 проходит', async () => {
    setupQueryOne({ restrictions: { ...ROLE_OFF, corrections_cap_by_schedule_norm: true }, anomalous: false, totalMinutes: 0, monthCount: 0 });
    await expect(assertCorrectionAllowed({
      ...BASE,
      hoursOverride: 14,
      scheduledNormHours: 12,
      correctionCapHours: 12,
      capHoursToCheck: null,
    })).resolves.toBeUndefined();
  });

  it('снижение старой правки 14 → 13 при пределе 12 — отказ', async () => {
    setupQueryOne({ restrictions: { ...ROLE_OFF, corrections_cap_by_schedule_norm: true }, anomalous: false, totalMinutes: 0, monthCount: 0 });
    await expect(assertCorrectionAllowed({
      ...BASE,
      hoursOverride: 13,
      scheduledNormHours: 12,
      correctionCapHours: 12,
      capHoursToCheck: 13,
    })).rejects.toMatchObject({ code: 'hours_exceed_norm' });
  });

  it('сравнение в сотых: 7,6667 при пределе 7,67 не превышение', async () => {
    setupQueryOne({ restrictions: { ...ROLE_OFF, corrections_cap_by_schedule_norm: true }, anomalous: false, totalMinutes: 0, monthCount: 0 });
    await expect(assertCorrectionAllowed({
      ...BASE,
      hoursOverride: 7.6667,
      scheduledNormHours: 7.67,
      correctionCapHours: 7.67,
      capHoursToCheck: 7.6667,
    })).resolves.toBeUndefined();
  });

  it('галочка роли снята: часы сверх графика проходят', async () => {
    setupQueryOne({ restrictions: ROLE_OFF, anomalous: false, totalMinutes: 0, monthCount: 0 });
    await expect(assertCorrectionAllowed({
      ...BASE,
      hoursOverride: 14,
      scheduledNormHours: 12,
      correctionCapHours: 12,
      capHoursToCheck: 14,
    })).resolves.toBeUndefined();
  });

  it('без skip-флага та же удалёнка в выходной блокируется (контроль)', async () => {
    setupQueryOne({ restrictions: ROLE_SITE_SUPERVISOR, anomalous: false, totalMinutes: 0, monthCount: 0 });
    await expect(assertCorrectionAllowed({
      ...BASE,
      hoursOverride: 8,
      scheduledNormHours: 0,
    })).rejects.toMatchObject({ code: 'not_anomalous' });
  });

  it('skip-флаг НЕ обходит месячный лимит: лимит=0 → monthly_limit (выходные закрыты для роли)', async () => {
    setupQueryOne({
      restrictions: { ...ROLE_SITE_SUPERVISOR, max_corrections_per_month: 0 },
      anomalous: false,
      totalMinutes: 0,
      monthCount: 0,
    });
    await expect(assertCorrectionAllowed({
      ...BASE,
      hoursOverride: 8,
      scheduledNormHours: 0, // выходной
      skipAnomalyCheck: true,
    })).rejects.toMatchObject({ code: 'monthly_limit', details: { limit: 0 } });
  });

  it('skip-флаг + лимит=null → проходит (норму/аномалию пропускаем, лимита нет)', async () => {
    setupQueryOne({
      restrictions: { ...ROLE_SITE_SUPERVISOR, max_corrections_per_month: null },
      anomalous: false,
      totalMinutes: 0,
      monthCount: 99,
    });
    await expect(assertCorrectionAllowed({
      ...BASE,
      hoursOverride: 8,
      scheduledNormHours: 0,
      skipAnomalyCheck: true,
    })).resolves.toBeUndefined();
  });

  it('skip-флаг + лимит достигнут (2/2) → monthly_limit', async () => {
    setupQueryOne({
      restrictions: { ...ROLE_SITE_SUPERVISOR, max_corrections_per_month: 2 },
      anomalous: false,
      totalMinutes: 0,
      monthCount: 2,
    });
    await expect(assertCorrectionAllowed({
      ...BASE,
      hoursOverride: 8,
      scheduledNormHours: 0,
      skipAnomalyCheck: true,
    })).rejects.toMatchObject({ code: 'monthly_limit', details: { limit: 2, used: 2 } });
  });

  it('блокирует при достижении max_corrections_per_month', async () => {
    setupQueryOne({
      restrictions: { ...ROLE_SITE_SUPERVISOR, max_corrections_per_month: 2 },
      anomalous: true,
      totalMinutes: 0,
      monthCount: 2,
    });
    await expect(assertCorrectionAllowed({
      ...BASE,
      hoursOverride: 8,
      scheduledNormHours: 8,
    })).rejects.toMatchObject({ code: 'monthly_limit', details: { limit: 2, used: 2 } });
  });

  it('пропускает hours>0 в аномальный день в пределах плана и лимита', async () => {
    setupQueryOne({
      restrictions: { ...ROLE_SITE_SUPERVISOR, max_corrections_per_month: 5 },
      anomalous: true,
      totalMinutes: 0,
      monthCount: 1,
    });
    await expect(assertCorrectionAllowed({
      ...BASE,
      hoursOverride: 8,
      scheduledNormHours: 8,
    })).resolves.toBeUndefined();
  });

  it('пропускает hours=0 для короткой явки в рабочий день', async () => {
    setupQueryOne({ restrictions: ROLE_SITE_SUPERVISOR, anomalous: false, totalMinutes: 120, monthCount: 0 });
    await expect(assertCorrectionAllowed({
      ...BASE,
      hoursOverride: 0,
      scheduledNormHours: 8,
    })).resolves.toBeUndefined();
  });

  it('пропускает hours=0 при факте >= 4ч (явное обнуление, ограничение снято)', async () => {
    setupQueryOne({ restrictions: ROLE_SITE_SUPERVISOR, anomalous: false, totalMinutes: 300, monthCount: 0 });
    await expect(assertCorrectionAllowed({
      ...BASE,
      hoursOverride: 0,
      scheduledNormHours: 8,
    })).resolves.toBeUndefined();
  });

  it('пропускает hours=0 в выходной по графику (явное обнуление, ограничение снято)', async () => {
    setupQueryOne({ restrictions: ROLE_SITE_SUPERVISOR, anomalous: false, totalMinutes: 0, monthCount: 0 });
    await expect(assertCorrectionAllowed({
      ...BASE,
      hoursOverride: 0,
      scheduledNormHours: 0,
    })).resolves.toBeUndefined();
  });

  it('пропускает hours=0 при anomalies_only (явное обнуление, ограничение снято)', async () => {
    setupQueryOne({
      restrictions: { ...ROLE_SITE_SUPERVISOR, corrections_allow_zero_short_attendance: false },
      anomalous: false,
      totalMinutes: 0,
      monthCount: 0,
    });
    await expect(assertCorrectionAllowed({
      ...BASE,
      hoursOverride: 0,
      scheduledNormHours: 8,
    })).resolves.toBeUndefined();
  });

  it('обнуление при достигнутом лимите аномалий пропускается (Type B вне лимита)', async () => {
    setupQueryOne({
      restrictions: { ...ROLE_SITE_SUPERVISOR, max_corrections_per_month: 0 },
      anomalous: false,
      totalMinutes: 0,
      monthCount: 99,
    });
    await expect(assertCorrectionAllowed({
      ...BASE,
      hoursOverride: 0,
      scheduledNormHours: 8,
    })).resolves.toBeUndefined();
  });

  it('cap_by_schedule_norm без anomalies_only — только cap, без проверки аномалии', async () => {
    setupQueryOne({
      restrictions: { ...ROLE_OFF, corrections_cap_by_schedule_norm: true },
      anomalous: false,
      totalMinutes: 0,
      monthCount: 0,
    });
    await expect(assertCorrectionAllowed({
      ...BASE,
      hoursOverride: 7,
      scheduledNormHours: 8,
      capHoursToCheck: 7,
    })).resolves.toBeUndefined();
    await expect(assertCorrectionAllowed({
      ...BASE,
      hoursOverride: 9,
      scheduledNormHours: 8,
      capHoursToCheck: 9,
    })).rejects.toMatchObject({ code: 'hours_exceed_norm' });
  });

  it('assertBulkAllowed: блок при disable_bulk=true', async () => {
    setupQueryOne({ restrictions: ROLE_SITE_SUPERVISOR, anomalous: false, totalMinutes: 0, monthCount: 0 });
    await expect(assertBulkAllowed(BASE.systemRoleId)).rejects.toBeInstanceOf(CorrectionRestrictionError);
  });

  it('assertBulkAllowed: пропускает при disable_bulk=false', async () => {
    setupQueryOne({ restrictions: ROLE_OFF, anomalous: false, totalMinutes: 0, monthCount: 0 });
    await expect(assertBulkAllowed(BASE.systemRoleId)).resolves.toBeUndefined();
  });

  it('assertObjectCorrectionsAllowed: блок при disable_object_entries=true', async () => {
    setupQueryOne({ restrictions: ROLE_SITE_SUPERVISOR, anomalous: false, totalMinutes: 0, monthCount: 0 });
    await expect(assertObjectCorrectionsAllowed(BASE.systemRoleId)).rejects.toMatchObject({ code: 'object_entries_disabled' });
  });

  it('assertObjectCorrectionsAllowed: пропускает при disable_object_entries=false', async () => {
    setupQueryOne({ restrictions: ROLE_OFF, anomalous: false, totalMinutes: 0, monthCount: 0 });
    await expect(assertObjectCorrectionsAllowed(BASE.systemRoleId)).resolves.toBeUndefined();
  });

  describe('assertBulkCorrectionAllowed (preflight)', () => {
    /**
     * Роутер для bulk: queryOne отвечает за роль + аномалии, query — за проекцию лимита
     * (SELECT ... FROM attendance_adjustments с to_char). existingRows = уже записанные
     * «считаемые» строки за месяц.
     */
    function setupBulk(opts: {
      restrictions: IRoleRow;
      anomalous: boolean;
      existingRows?: Array<{ employee_id: number; ym: string; d: string }>;
    }) {
      pgQueryOne.mockImplementation(async (sql: string) => {
        if (/FROM\s+system_roles/i.test(sql)) return opts.restrictions;
        if (/is_skud_anomalous_day/.test(sql)) return { anomalous: opts.anomalous };
        return null;
      });
      pgQuery.mockImplementation(async (sql: string) => {
        if (/FROM\s+attendance_adjustments/i.test(sql)) return opts.existingRows ?? [];
        return [];
      });
    }

    const ROLE_LIMIT3: IRoleRow = { ...ROLE_SITE_SUPERVISOR, max_corrections_per_month: 3 };
    const bulkBase = { systemRoleId: BASE.systemRoleId, createdBy: BASE.createdBy };

    it('all-or-nothing: 4 даты одного сотрудника за месяц → monthly_limit (ничего не пишется)', async () => {
      setupBulk({ restrictions: ROLE_LIMIT3, anomalous: true });
      await expect(assertBulkCorrectionAllowed({
        ...bulkBase,
        items: ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04'].map(d => ({
          employeeId: 42, workDate: d, hoursOverride: 8, scheduledNormHours: 8, correctionCapHours: 8, capHoursToCheck: null,
        })),
      })).rejects.toMatchObject({ code: 'monthly_limit', details: { employeeId: 42 } });
    });

    it('несколько сотрудников по 1 дню — проходит (лимит per-employee)', async () => {
      setupBulk({ restrictions: ROLE_LIMIT3, anomalous: true });
      await expect(assertBulkCorrectionAllowed({
        ...bulkBase,
        items: [10, 11, 12, 13].map(emp => ({
          employeeId: emp, workDate: '2026-06-01', hoursOverride: 8, scheduledNormHours: 8, correctionCapHours: 8, capHoursToCheck: null,
        })),
      })).resolves.toBeUndefined();
    });

    it('учитывает уже записанные даты месяца (проекция объединением)', async () => {
      // 2 существующие + 2 новые даты = 4 > 3 → блок
      setupBulk({
        restrictions: ROLE_LIMIT3,
        anomalous: true,
        existingRows: [
          { employee_id: 42, ym: '2026-06', d: '2026-06-10' },
          { employee_id: 42, ym: '2026-06', d: '2026-06-11' },
        ],
      });
      await expect(assertBulkCorrectionAllowed({
        ...bulkBase,
        items: ['2026-06-01', '2026-06-02'].map(d => ({
          employeeId: 42, workDate: d, hoursOverride: 8, scheduledNormHours: 8, correctionCapHours: 8, capHoursToCheck: null,
        })),
      })).rejects.toMatchObject({ code: 'monthly_limit' });
    });

    it('повторная правка существующей даты не задваивает счётчик', async () => {
      // 2 существующие, обе перезаписываются батчем (те же даты) → union=2 ≤ 3 → проходит
      setupBulk({
        restrictions: ROLE_LIMIT3,
        anomalous: true,
        existingRows: [
          { employee_id: 42, ym: '2026-06', d: '2026-06-10' },
          { employee_id: 42, ym: '2026-06', d: '2026-06-11' },
        ],
      });
      await expect(assertBulkCorrectionAllowed({
        ...bulkBase,
        items: ['2026-06-10', '2026-06-11'].map(d => ({
          employeeId: 42, workDate: d, hoursOverride: 8, scheduledNormHours: 8, correctionCapHours: 8, capHoursToCheck: null,
        })),
      })).resolves.toBeUndefined();
    });

    it('неаномальный день в батче → not_anomalous', async () => {
      setupBulk({ restrictions: ROLE_LIMIT3, anomalous: false });
      await expect(assertBulkCorrectionAllowed({
        ...bulkBase,
        items: [{ employeeId: 42, workDate: '2026-06-01', hoursOverride: 8, scheduledNormHours: 8, correctionCapHours: 8, capHoursToCheck: null }],
      })).rejects.toMatchObject({ code: 'not_anomalous' });
    });

    it('часы > нормы в батче → hours_exceed_norm', async () => {
      setupBulk({ restrictions: ROLE_LIMIT3, anomalous: true });
      await expect(assertBulkCorrectionAllowed({
        ...bulkBase,
        items: [{ employeeId: 42, workDate: '2026-06-01', hoursOverride: 10, scheduledNormHours: 8, correctionCapHours: 8, capHoursToCheck: 10 }],
      })).rejects.toMatchObject({ code: 'hours_exceed_norm' });
    });

    it('отказ называет человека и день: пн–пт по 8 ч при пятнице 7 ч', async () => {
      setupBulk({ restrictions: { ...ROLE_OFF, corrections_cap_by_schedule_norm: true }, anomalous: false });
      pgQueryOne.mockImplementation(async (sql: string) => {
        if (/FROM\s+system_roles/i.test(sql)) return { ...ROLE_OFF, corrections_cap_by_schedule_norm: true };
        if (/FROM employees/.test(sql)) return { full_name: 'Иванов Иван' };
        return null;
      });
      const week = ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13'].map((workDate, i) => ({
        employeeId: 42,
        workDate,
        hoursOverride: 8,
        scheduledNormHours: i === 4 ? 7 : 8,
        correctionCapHours: i === 4 ? 7 : 8,
        capHoursToCheck: 8,
      }));
      await expect(assertBulkCorrectionAllowed({ ...bulkBase, items: week })).rejects.toMatchObject({
        code: 'hours_exceed_norm',
        message: 'Иванов Иван, 13.11.2026: часы корректировки (8) больше графика дня (7). Ничего не сохранено.',
        details: { employeeId: 42, workDate: '2026-11-13', correctionCapHours: 7 },
      });
    });

    it('повторная массовая правка старых часов (capHoursToCheck=null) проходит', async () => {
      setupBulk({ restrictions: { ...ROLE_OFF, corrections_cap_by_schedule_norm: true }, anomalous: false });
      await expect(assertBulkCorrectionAllowed({
        ...bulkBase,
        items: [{ employeeId: 42, workDate: '2026-06-01', hoursOverride: 14, scheduledNormHours: 12, correctionCapHours: 12, capHoursToCheck: null }],
      })).resolves.toBeUndefined();
    });

    it('роль без ограничений — no-op', async () => {
      setupBulk({ restrictions: ROLE_OFF, anomalous: false });
      await expect(assertBulkCorrectionAllowed({
        ...bulkBase,
        items: [{ employeeId: 42, workDate: '2026-06-01', hoursOverride: 8, scheduledNormHours: 8, correctionCapHours: 8, capHoursToCheck: null }],
      })).resolves.toBeUndefined();
    });

    it('галочка роли снята: сверх графика проходит', async () => {
      setupBulk({ restrictions: ROLE_OFF, anomalous: false });
      await expect(assertBulkCorrectionAllowed({
        ...bulkBase,
        items: [{ employeeId: 42, workDate: '2026-06-01', hoursOverride: 14, scheduledNormHours: 12, correctionCapHours: 12, capHoursToCheck: 14 }],
      })).resolves.toBeUndefined();
    });

    it('позиции с hours<=0 (обнуление) не считаются в лимит', async () => {
      setupBulk({ restrictions: { ...ROLE_LIMIT3, max_corrections_per_month: 1 }, anomalous: true });
      await expect(assertBulkCorrectionAllowed({
        ...bulkBase,
        items: ['2026-06-01', '2026-06-02', '2026-06-03'].map(d => ({
          employeeId: 42, workDate: d, hoursOverride: 0, scheduledNormHours: 8, correctionCapHours: 8, capHoursToCheck: null,
        })),
      })).resolves.toBeUndefined();
    });
  });

  describe('assertDayCorrectionsWithinCap', () => {
    const dayInput = { ...BASE, hours: 6, correctionCapHours: 8 };
    const ROLE_CAP: IRoleRow = { ...ROLE_OFF, corrections_cap_by_schedule_norm: true };

    const setup = (restrictions: IRoleRow, total: string) => {
      setupQueryOne({ restrictions, anomalous: false, totalMinutes: 0, monthCount: 0 });
      pgQuery.mockResolvedValue([{ total }]);
    };

    it('6 ч на объекте А + 6 ч на объекте Б при графике 8 ч — отказ', async () => {
      setup(ROLE_CAP, '6.00');
      await expect(assertDayCorrectionsWithinCap(null, dayInput)).rejects.toMatchObject({
        code: 'hours_exceed_norm',
        details: { otherHours: 6, correctionCapHours: 8 },
      });
    });

    it('сумма ровно по графику проходит', async () => {
      setup(ROLE_CAP, '2.00');
      await expect(assertDayCorrectionsWithinCap(null, dayInput)).resolves.toBeUndefined();
    });

    it('галочка роли снята: ни сумма, ни запрос не выполняются', async () => {
      setup(ROLE_OFF, '6.00');
      await expect(assertDayCorrectionsWithinCap(null, dayInput)).resolves.toBeUndefined();
      expect(pgQuery).not.toHaveBeenCalled();
    });

    it('под локом читает через exec и исключает правимую строку', async () => {
      setup(ROLE_CAP, '0');
      const exec = { query: vi.fn(async () => ({ rows: [{ total: '1.50' }] })) };
      await assertDayCorrectionsWithinCap(exec as never, { ...dayInput, excludeAdjustmentId: 77 });
      expect(pgQuery).not.toHaveBeenCalled();
      expect(exec.query).toHaveBeenCalledWith(expect.stringContaining('IS DISTINCT FROM'), [42, '2026-05-12', 77]);
    });

    it('заявление без объекта: только предел самой строки', async () => {
      setup(ROLE_CAP, '6.00');
      await expect(assertDayCorrectionsWithinCap(null, { ...dayInput, includeObjectRows: false })).resolves.toBeUndefined();
      expect(pgQuery).not.toHaveBeenCalled();
      await expect(assertDayCorrectionsWithinCap(null, { ...dayInput, hours: 9, includeObjectRows: false }))
        .rejects.toMatchObject({ code: 'hours_exceed_norm' });
    });
  });
});
