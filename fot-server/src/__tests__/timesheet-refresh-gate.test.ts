import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * POST /api/timesheet/refresh изменяет данные (пересчёт табеля) — гейт обязан быть
 * 'edit', а не 'view', и сохранять оба контура ('/timesheet' и '/timesheet-hr').
 * Иначе view-only роли (например, security с view_all_departments) смогут
 * запускать пересчёт. Контракт по исходнику — зеркало access-page-catalog-contract.
 */
describe('timesheet.routes — гейт POST /refresh', () => {
  it("использует requireAnyPageAccess(['/timesheet', '/timesheet-hr'], 'edit')", () => {
    const source = readFileSync(
      path.resolve(__dirname, '..', 'routes', 'timesheet.routes.ts'),
      'utf8',
    );
    const refreshBlock = source.match(/router\.post\(\s*'\/refresh'[\s\S]*?\);/)?.[0] ?? '';
    expect(refreshBlock).not.toBe('');
    expect(refreshBlock).toMatch(/requireAnyPageAccess\(\s*\[\s*'\/timesheet'\s*,\s*'\/timesheet-hr'\s*\]\s*,\s*'edit'\s*\)/);
  });
});
