import { describe, expect, it } from 'vitest';
import type { UserProfile } from '../types/auth';
import { hasGlobalTimesheetReadScope } from './globalTimesheetRead';

/** Профиль — только поля, которые читает helper. */
const profile = (fields: Partial<UserProfile>): UserProfile => fields as UserProfile;

describe('hasGlobalTimesheetReadScope — флаг роли «Все отделы на чтение»', () => {
  it('роль с флагом («Учёт проживания») — да', () => {
    expect(hasGlobalTimesheetReadScope(profile({ role_code: 'checks', is_admin: false, view_all_departments: true }))).toBe(true);
  });

  it('у табельщицы флаг не действует', () => {
    expect(hasGlobalTimesheetReadScope(profile({ role_code: 'timekeeper', is_admin: false, view_all_departments: true }))).toBe(false);
  });

  it('у администратора флаг не действует — у него своя логика', () => {
    expect(hasGlobalTimesheetReadScope(profile({ role_code: 'admin', is_admin: true, view_all_departments: true }))).toBe(false);
  });

  it('без флага или без профиля — нет', () => {
    expect(hasGlobalTimesheetReadScope(profile({ role_code: 'checks', is_admin: false, view_all_departments: false }))).toBe(false);
    expect(hasGlobalTimesheetReadScope(null)).toBe(false);
  });
});
