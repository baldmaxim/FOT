/**
 * Контракт маршрутов статуса «Неактивный» (миграция 381): перевод и возврат защищены 2FA-гардом, как «Уволить»;
 * разбивка ИТР / Рабочие / Остальные объявлена раньше '/:id', иначе её перехватил бы параметр.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/features.js', () => ({ CRITICAL_2FA_ENABLED: false, LOGIN_2FA_ENABLED: false, IS_PRODUCTION: false }));
vi.mock('../services/access-control.service.js', () => ({
  resolveEffectivePageAccess: vi.fn(async () => true),
  resolveRolePageAccess: vi.fn(async () => true),
}));
vi.mock('../services/local-auth.service.js', () => ({}));

import { requireCritical2FA } from '../middleware/auth.js';
import { deactivateEmployee, reactivateEmployee } from '../controllers/employee-inactive.controller.js';
import employeesRouter from './employees.routes.js';

interface ILayer {
  route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> };
}
const layers = (employeesRouter as unknown as { stack: ILayer[] }).stack;

const indexOf = (method: string, path: string): number =>
  layers.findIndex(layer => layer.route?.path === path && layer.route.methods[method]);

const stackOf = (method: string, path: string): Array<{ handle: unknown }> => {
  const layer = layers[indexOf(method, path)];
  if (!layer?.route) throw new Error(`маршрут ${method.toUpperCase()} ${path} не найден`);
  return layer.route.stack;
};

describe('маршруты «Неактивный»', () => {
  it.each([
    ['/:id/deactivate', deactivateEmployee],
    ['/:id/reactivate', reactivateEmployee],
  ])('POST %s — 2FA-гард и обработчик контроллера', (path, handler) => {
    const stack = stackOf('post', path);
    expect(stack.some(layer => layer.handle === requireCritical2FA)).toBe(true);
    expect(stack[stack.length - 1].handle).toBe(handler);
  });

  it('GET /category-counts объявлен раньше GET /:id', () => {
    const counts = indexOf('get', '/category-counts');
    const byId = indexOf('get', '/:id');
    expect(counts).toBeGreaterThan(-1);
    expect(byId).toBeGreaterThan(-1);
    expect(counts).toBeLessThan(byId);
  });
});
