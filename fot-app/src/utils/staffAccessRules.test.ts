import { describe, it, expect } from 'vitest';
import { normalizeStaffStatusPeriod, resolveStaffAccessRules } from './staffAccessRules';

/** Табельщица на проде: скоуп по бригадам, «Управление кадрами» на просмотр. */
const TIMEKEEPER = {
  isAdmin: false,
  roleCode: 'timekeeper',
  hasAllEmployeesKey: false,
  canManageStaff: false,
  isDepartmentScope: true,
};

describe('resolveStaffAccessRules', () => {
  it('табельщица без ключа — как сейчас: свои бригады, без «Уволенных»', () => {
    expect(resolveStaffAccessRules(TIMEKEEPER)).toEqual({
      hasAllEmployees: false,
      restrictToManaged: true,
      canViewFired: false,
      defaultSection: 'all',
    });
  });

  it('табельщица с ключом — вся организация: фильтр отделов не сужен, «Уволенные» и чипы видны, раздел «СУ-10»', () => {
    expect(resolveStaffAccessRules({ ...TIMEKEEPER, hasAllEmployeesKey: true })).toEqual({
      hasAllEmployees: true,
      restrictToManaged: false,
      canViewFired: true,
      defaultSection: 'su10',
    });
  });

  it('другая роль с тем же ключом — ничего не меняется', () => {
    expect(resolveStaffAccessRules({ ...TIMEKEEPER, roleCode: 'site_supervisor', hasAllEmployeesKey: true })).toEqual({
      hasAllEmployees: false,
      restrictToManaged: true,
      canViewFired: false,
      defaultSection: 'all',
    });
  });

  it('администратор: canViewPage отдаёт true на любом ключе, но право к нему не относится', () => {
    expect(resolveStaffAccessRules({
      isAdmin: true,
      roleCode: 'admin',
      hasAllEmployeesKey: true,
      canManageStaff: true,
      isDepartmentScope: false,
    })).toEqual({ hasAllEmployees: false, restrictToManaged: false, canViewFired: true, defaultSection: 'su10' });
  });

  it('руководитель с назначенными отделами открывает «Все»: его отделы могут быть не в СУ-10', () => {
    expect(resolveStaffAccessRules({
      isAdmin: false,
      roleCode: 'manager',
      hasAllEmployeesKey: false,
      canManageStaff: false,
      isDepartmentScope: true,
    }).defaultSection).toBe('all');
  });

  it('кадровый админ видит «Уволенных» по своему праву управления', () => {
    expect(resolveStaffAccessRules({
      isAdmin: false,
      roleCode: 'hr_admin',
      hasAllEmployeesKey: false,
      canManageStaff: true,
      isDepartmentScope: false,
    })).toEqual({ hasAllEmployees: false, restrictToManaged: false, canViewFired: true, defaultSection: 'su10' });
  });
});

describe('normalizeStaffStatusPeriod', () => {
  it('с правом ссылка ?status=fired&period=fired_month остаётся как есть', () => {
    expect(normalizeStaffStatusPeriod({ status: 'fired', period: 'fired_month' }, true))
      .toEqual({ status: 'fired', period: 'fired_month' });
  });

  it('без права «Уволенные» из чужой ссылки сбрасываются вместе с периодом', () => {
    expect(normalizeStaffStatusPeriod({ status: 'fired', period: 'fired_month' }, false))
      .toEqual({ status: 'active', period: null });
  });

  it('без права период снимается и на «Действующих» — чипов на экране нет', () => {
    expect(normalizeStaffStatusPeriod({ status: 'active', period: 'hired_month' }, false))
      .toEqual({ status: 'active', period: null });
  });

  it('без периода и на «Действующих» менять нечего', () => {
    expect(normalizeStaffStatusPeriod({ status: 'active', period: null }, false))
      .toEqual({ status: 'active', period: null });
  });
});
