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
    })).rejects.toMatchObject({ code: 'hours_exceed_norm' });
  });

  it('skipNormAndAnomalyChecks: удалёнка поверх согласованного выхода в выходной (норма 0) не блокируется', async () => {
    setupQueryOne({ restrictions: ROLE_SITE_SUPERVISOR, anomalous: false, totalMinutes: 0, monthCount: 0 });
    await expect(assertCorrectionAllowed({
      ...BASE,
      hoursOverride: 8,
      scheduledNormHours: 0, // выходной
      skipNormAndAnomalyChecks: true,
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
    })).resolves.toBeUndefined();
    await expect(assertCorrectionAllowed({
      ...BASE,
      hoursOverride: 9,
      scheduledNormHours: 8,
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
          employeeId: 42, workDate: d, hoursOverride: 8, scheduledNormHours: 8,
        })),
      })).rejects.toMatchObject({ code: 'monthly_limit', details: { employeeId: 42 } });
    });

    it('несколько сотрудников по 1 дню — проходит (лимит per-employee)', async () => {
      setupBulk({ restrictions: ROLE_LIMIT3, anomalous: true });
      await expect(assertBulkCorrectionAllowed({
        ...bulkBase,
        items: [10, 11, 12, 13].map(emp => ({
          employeeId: emp, workDate: '2026-06-01', hoursOverride: 8, scheduledNormHours: 8,
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
          employeeId: 42, workDate: d, hoursOverride: 8, scheduledNormHours: 8,
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
          employeeId: 42, workDate: d, hoursOverride: 8, scheduledNormHours: 8,
        })),
      })).resolves.toBeUndefined();
    });

    it('неаномальный день в батче → not_anomalous', async () => {
      setupBulk({ restrictions: ROLE_LIMIT3, anomalous: false });
      await expect(assertBulkCorrectionAllowed({
        ...bulkBase,
        items: [{ employeeId: 42, workDate: '2026-06-01', hoursOverride: 8, scheduledNormHours: 8 }],
      })).rejects.toMatchObject({ code: 'not_anomalous' });
    });

    it('часы > нормы в батче → hours_exceed_norm', async () => {
      setupBulk({ restrictions: ROLE_LIMIT3, anomalous: true });
      await expect(assertBulkCorrectionAllowed({
        ...bulkBase,
        items: [{ employeeId: 42, workDate: '2026-06-01', hoursOverride: 10, scheduledNormHours: 8 }],
      })).rejects.toMatchObject({ code: 'hours_exceed_norm' });
    });

    it('роль без ограничений — no-op', async () => {
      setupBulk({ restrictions: ROLE_OFF, anomalous: false });
      await expect(assertBulkCorrectionAllowed({
        ...bulkBase,
        items: [{ employeeId: 42, workDate: '2026-06-01', hoursOverride: 8, scheduledNormHours: 8 }],
      })).resolves.toBeUndefined();
    });

    it('позиции с hours<=0 (обнуление) не считаются в лимит', async () => {
      setupBulk({ restrictions: { ...ROLE_LIMIT3, max_corrections_per_month: 1 }, anomalous: true });
      await expect(assertBulkCorrectionAllowed({
        ...bulkBase,
        items: ['2026-06-01', '2026-06-02', '2026-06-03'].map(d => ({
          employeeId: 42, workDate: d, hoursOverride: 0, scheduledNormHours: 8,
        })),
      })).resolves.toBeUndefined();
    });
  });
});
