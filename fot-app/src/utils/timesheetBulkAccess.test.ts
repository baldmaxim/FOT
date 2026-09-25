import { describe, it, expect } from 'vitest';
import { canUseBulkCorrections } from './timesheetBulkAccess';

const EDITABLE = { editable: true };
const READ_ONLY = { editable: false };

describe('canUseBulkCorrections', () => {
  it('отдел доступен на запись — кнопка есть', () => {
    expect(canUseBulkCorrections({
      canWriteActiveDept: true,
      canEditTimesheet: true,
      isDirectReportsGrid: false,
      employees: [READ_ONLY],
    })).toBe(true);
  });

  it('отдел только на просмотр — кнопки нет, даже если строки редактируемы', () => {
    expect(canUseBulkCorrections({
      canWriteActiveDept: false,
      canEditTimesheet: true,
      isDirectReportsGrid: false,
      employees: [EDITABLE],
    })).toBe(false);
  });

  it('«Мои сотрудники» с одной редактируемой строкой — кнопка есть (рук.строй без отделов)', () => {
    expect(canUseBulkCorrections({
      canWriteActiveDept: false,
      canEditTimesheet: true,
      isDirectReportsGrid: true,
      employees: [READ_ONLY, EDITABLE],
    })).toBe(true);
  });

  it('«Мои сотрудники», все строки только на просмотр — кнопки нет', () => {
    expect(canUseBulkCorrections({
      canWriteActiveDept: false,
      canEditTimesheet: true,
      isDirectReportsGrid: true,
      employees: [READ_ONLY, READ_ONLY],
    })).toBe(false);
  });

  it('«Мои сотрудники» без права правки страницы — кнопки нет', () => {
    expect(canUseBulkCorrections({
      canWriteActiveDept: false,
      canEditTimesheet: false,
      isDirectReportsGrid: true,
      employees: [EDITABLE],
    })).toBe(false);
  });

  it('«Мои сотрудники» до загрузки строк — кнопки нет', () => {
    expect(canUseBulkCorrections({
      canWriteActiveDept: false,
      canEditTimesheet: true,
      isDirectReportsGrid: true,
      employees: [],
    })).toBe(false);
  });
});
