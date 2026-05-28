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
  CorrectionRestrictionError,
  invalidateCorrectionRestrictionsCache,
} from './correction-restrictions.service.js';

interface IRoleRow {
  corrections_anomalies_only: boolean;
  corrections_cap_by_schedule_norm: boolean;
  corrections_allow_zero_short_attendance: boolean;
  corrections_disable_bulk: boolean;
  max_corrections_per_month: number | null;
}

const ROLE_OFF: IRoleRow = {
  corrections_anomalies_only: false,
  corrections_cap_by_schedule_norm: false,
  corrections_allow_zero_short_attendance: false,
  corrections_disable_bulk: false,
  max_corrections_per_month: null,
};

const ROLE_SITE_SUPERVISOR: IRoleRow = {
  corrections_anomalies_only: true,
  corrections_cap_by_schedule_norm: true,
  corrections_allow_zero_short_attendance: true,
  corrections_disable_bulk: true,
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

  it('блокирует hours=0 при факте >= 4ч (short_attendance_not_eligible)', async () => {
    setupQueryOne({ restrictions: ROLE_SITE_SUPERVISOR, anomalous: false, totalMinutes: 300, monthCount: 0 });
    await expect(assertCorrectionAllowed({
      ...BASE,
      hoursOverride: 0,
      scheduledNormHours: 8,
    })).rejects.toMatchObject({ code: 'short_attendance_not_eligible' });
  });

  it('блокирует hours=0 в выходной по графику', async () => {
    setupQueryOne({ restrictions: ROLE_SITE_SUPERVISOR, anomalous: false, totalMinutes: 0, monthCount: 0 });
    await expect(assertCorrectionAllowed({
      ...BASE,
      hoursOverride: 0,
      scheduledNormHours: 0,
    })).rejects.toMatchObject({ code: 'short_attendance_not_eligible' });
  });

  it('блокирует hours=0 при anomalies_only без allow_zero_short_attendance (zero_not_allowed)', async () => {
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
    })).rejects.toMatchObject({ code: 'zero_not_allowed' });
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
});
