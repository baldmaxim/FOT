/**
 * Единое правило входа (миграция 381): уволенный и неактивный не входят, служебная учётка с
 * login_when_staff_inactive неактивностью не блокируется, но увольнением — да.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ queryOne: vi.fn(), query: vi.fn() }));

vi.mock('../config/postgres.js', () => ({ queryOne: h.queryOne, query: h.query }));

import {
  getProfileAccessState,
  getProfileEmploymentBlock,
  resolveEmploymentBlock,
  toEmploymentAccessState,
} from './account-status.service.js';
import { invalidateDeptTreeCache } from './skud-shared.service.js';

const ARCHIVE_ID = '19e1ca6c-c93a-486c-bd09-caae0dbfaa93';

beforeEach(() => {
  h.queryOne.mockReset();
  h.query.mockReset();
  h.query.mockResolvedValue([
    { id: 'su10', parent_id: null, name: '(СУ-10) ООО СУ-10', sigur_department_id: null },
    { id: ARCHIVE_ID, parent_id: 'su10', name: 'Архив', sigur_department_id: 1 },
  ]);
  invalidateDeptTreeCache();
});

describe('resolveEmploymentBlock', () => {
  const block = (employmentStatus: string | null, staffInactive: boolean, loginWhenStaffInactive = false) =>
    resolveEmploymentBlock({ employmentStatus, staffInactive, loginWhenStaffInactive })?.code ?? null;

  it('работающий и профиль без карточки — пускать', () => {
    expect(block('active', false)).toBeNull();
    expect(block(null, false)).toBeNull();
  });

  it('уволенный — EMPLOYEE_DISMISSED, даже служебная учётка и даже при неактивности', () => {
    expect(block('fired', false)).toBe('EMPLOYEE_DISMISSED');
    expect(block('fired', true)).toBe('EMPLOYEE_DISMISSED');
    expect(block('fired', false, true)).toBe('EMPLOYEE_DISMISSED');
  });

  it('неактивный — EMPLOYEE_INACTIVE; служебная учётка — пускать', () => {
    expect(block('active', true)).toBe('EMPLOYEE_INACTIVE');
    expect(block('active', true, true)).toBeNull();
  });

  it('toEmploymentAccessState: NULL из БД — не блокирует', () => {
    expect(toEmploymentAccessState({ employment_status: null, staff_inactive: null, login_when_staff_inactive: null }))
      .toEqual({ employmentStatus: null, staffInactive: false, loginWhenStaffInactive: false });
    expect(toEmploymentAccessState(null)).toEqual({ employmentStatus: null, staffInactive: false, loginWhenStaffInactive: false });
  });
});

describe('getProfileAccessState', () => {
  it('один запрос: увольнение, неактивность (ручная метка или ветка «Архив»), флаг учётки, отключение, версия', async () => {
    h.queryOne.mockResolvedValue({
      employment_status: 'active', staff_inactive: true, login_when_staff_inactive: true, is_disabled: null, token_version: '7',
    });
    const state = await getProfileAccessState('a4568fc6-c448-4f90-b9a4-02b774de4fcc');
    expect(state).toEqual({
      employmentStatus: 'active', staffInactive: true, loginWhenStaffInactive: true, isDisabled: false, tokenVersion: 7,
    });
    const [sql, params] = h.queryOne.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('e.staff_inactive_at IS NOT NULL OR COALESCE(e.org_department_id = ANY($2::uuid[]), false)');
    expect(sql).toContain('up.login_when_staff_inactive');
    expect(params).toEqual(['a4568fc6-c448-4f90-b9a4-02b774de4fcc', [ARCHIVE_ID]]);
  });

  it('профиль не найден — null; блокировки нет', async () => {
    h.queryOne.mockResolvedValue(null);
    expect(await getProfileAccessState('x')).toBeNull();
    expect(await getProfileEmploymentBlock('x')).toBeNull();
  });

  it('getProfileEmploymentBlock — по тому же правилу', async () => {
    h.queryOne.mockResolvedValue({
      employment_status: 'active', staff_inactive: true, login_when_staff_inactive: false, is_disabled: false, token_version: 0,
    });
    expect(await getProfileEmploymentBlock('x')).toEqual({
      code: 'EMPLOYEE_INACTIVE',
      error: 'Учётная запись отключена: сотрудник переведён в неактивные',
    });
  });
});
