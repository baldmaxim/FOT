import { describe, expect, it, vi } from 'vitest';

// Импорт сервиса тянет postgres/settings — мокаем, тест проверяет чистую функцию.
vi.mock('../config/postgres.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));
vi.mock('./correction-approval-settings.service.js', () => ({
  correctionApprovalSettingsService: { getRequiredDepartmentIds: vi.fn() },
}));

import { resolveFromMaps } from './weekend-approval-assignments.service.js';

describe('resolveFromMaps', () => {
  const maps = {
    byEmployee: new Map<number, number>([[6, 600]]),
    byDepartment: new Map<string, number>([['D1', 100], ['D6', 601]]),
  };

  it('приоритет привязки по сотруднику над отделом', () => {
    expect(resolveFromMaps(maps, 6, 'D6')).toBe(600);
  });

  it('фолбэк на привязку по отделу', () => {
    expect(resolveFromMaps(maps, 1, 'D1')).toBe(100);
  });

  it('нет привязки → null', () => {
    expect(resolveFromMaps(maps, 2, 'D2')).toBeNull();
  });

  it('нет отдела и нет привязки по сотруднику → null', () => {
    expect(resolveFromMaps(maps, 2, null)).toBeNull();
  });
});
