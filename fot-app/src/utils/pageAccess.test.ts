import { describe, expect, it } from 'vitest';

import type { UserProfile } from '../types/auth';
import { PAYROLL_SECTION_PAGES, isPayrollSectionPage, profileCanEditPage, profileCanViewPage } from './pageAccess';

type Profile = Pick<UserProfile, 'is_admin' | 'page_access'>;

const SALARY_KEYS = [
  '/salary/payments',
  '/salary/payments/calculate',
  '/salary/payments/approve',
  '/salary/terms',
  '/salary/sick-leaves',
  '/salary/vacations',
  '/salary/deductions',
];

const salaryAccess = Object.fromEntries(SALARY_KEYS.map(key => [key, { can_view: true, can_edit: true }]));

const admin = (pageAccess: Profile['page_access'] = {}): Profile => ({ is_admin: true, page_access: pageAccess });
const office = (pageAccess: Profile['page_access'] = {}): Profile => ({ is_admin: false, page_access: pageAccess });

describe('раздел «Зарплата» — только по page_access, даже у администратора', () => {
  it('ключи раздела — ровно семь, как на сервере', () => {
    expect([...PAYROLL_SECTION_PAGES].sort()).toEqual([...SALARY_KEYS].sort());
  });

  it('«Повышение оклада» и прочие /salary* ключи разделом не считаются', () => {
    for (const key of ['/salary-raise-review', '/salary', '/salary/unknown']) {
      expect(isPayrollSectionPage(key)).toBe(false);
    }
  });

  it('админ не из списка (ключей нет) раздел не видит и не правит', () => {
    for (const key of SALARY_KEYS) {
      expect(profileCanViewPage(admin(), key)).toBe(false);
      expect(profileCanEditPage(admin(), key)).toBe(false);
    }
  });

  it('админ из списка — весь раздел', () => {
    for (const key of SALARY_KEYS) {
      expect(profileCanViewPage(admin(salaryAccess), key)).toBe(true);
      expect(profileCanEditPage(admin(salaryAccess), key)).toBe(true);
    }
  });

  it('прочие страницы, включая «Повышение оклада», админу открыты как раньше', () => {
    for (const key of ['/salary-raise-review', '/employees', '/admin/users']) {
      expect(profileCanViewPage(admin(), key)).toBe(true);
      expect(profileCanEditPage(admin(), key)).toBe(true);
    }
  });

  it('не-админ — по page_access', () => {
    expect(profileCanViewPage(office(salaryAccess), '/salary/terms')).toBe(true);
    expect(profileCanViewPage(office(), '/salary/terms')).toBe(false);
    expect(profileCanViewPage(office({ '/employees': { can_view: false, can_edit: true } }), '/employees')).toBe(true);
    expect(profileCanEditPage(office({ '/employees': { can_view: true, can_edit: false } }), '/employees')).toBe(false);
  });

  it('без профиля — ничего', () => {
    expect(profileCanViewPage(null, '/employees')).toBe(false);
    expect(profileCanEditPage(undefined, '/employees')).toBe(false);
  });
});
