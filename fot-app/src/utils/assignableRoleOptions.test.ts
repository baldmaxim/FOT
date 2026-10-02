import { describe, it, expect } from 'vitest';
import { filterAssignableRoleOptions } from './assignableRoleOptions';

const ROLES = [
  { code: 'admin', is_active: true, assignable: false },
  { code: 'hr_admin', is_active: true, assignable: false },
  { code: 'office', is_active: true, assignable: true },
  { code: 'worker', is_active: true, assignable: true },
  { code: 'legacy', is_active: false, assignable: true },
];

const codes = (list: Array<{ code: string }>) => list.map(role => role.code);

describe('filterAssignableRoleOptions', () => {
  it('админ видит все активные роли', () => {
    expect(codes(filterAssignableRoleOptions(ROLES, 'worker', true)))
      .toEqual(['admin', 'hr_admin', 'office', 'worker']);
  });

  it('кадровый админ видит только роли из allowlist', () => {
    expect(codes(filterAssignableRoleOptions(ROLES, 'worker', false)))
      .toEqual(['office', 'worker']);
  });

  it('текущая роль остаётся, даже если её нельзя выдать', () => {
    expect(codes(filterAssignableRoleOptions(ROLES, 'admin', false)))
      .toEqual(['admin', 'office', 'worker']);
  });

  it('неактивная роль — только если она текущая', () => {
    expect(codes(filterAssignableRoleOptions(ROLES, 'legacy', false)))
      .toEqual(['office', 'worker', 'legacy']);
  });

  it('без флага assignable (старый ответ сервера) не-админу роли не предлагаются', () => {
    const roles = [{ code: 'office', is_active: true }, { code: 'worker', is_active: true }];
    expect(codes(filterAssignableRoleOptions(roles, 'worker', false))).toEqual(['worker']);
  });
});
