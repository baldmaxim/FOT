/**
 * Политика 2FA для кадрового модуля («Реквизиты»).
 *
 * Раньше запись закрывал собственный requireHr2FA: 2FA обязательна всегда. На проде
 * её включили 3 человека из 1893 (среди админов, табельщиц и кадровиков — ни одного),
 * а единственный экран настройки скрыт флагом SHOW_SECURITY_CARD, поэтому гейт
 * закрывал модуль для всех. Перешли на существующий require2FA — условную проверку.
 *
 * requireCritical2FA здесь не подходит: при CRITICAL_2FA_ENABLED=false он вызывает
 * next() до всякой проверки и пропустил бы пользователя с включённой, но
 * неподтверждённой 2FA.
 *
 * Оговорка: пока LOGIN_2FA_ENABLED=false, логин выдаёт токен с two_factor_verified=true,
 * то есть кода не спросят ни у кого. Ветка 403 заработает после включения этого флага —
 * без правок HR-кода.
 */
import { describe, expect, it, vi } from 'vitest';
import type { NextFunction, Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

vi.mock('../config/features.js', () => ({ CRITICAL_2FA_ENABLED: false, LOGIN_2FA_ENABLED: false, IS_PRODUCTION: false }));
vi.mock('../services/access-control.service.js', () => ({ resolveEffectivePageAccess: vi.fn(async () => true) }));
vi.mock('../services/local-auth.service.js', () => ({}));

import { require2FA } from './auth.js';
import hrRouter from '../routes/hr-profiles.routes.js';

const run = (user: Partial<AuthenticatedRequest['user']> | null): { status: number; called: boolean } => {
  let status = 200;
  const res = {
    status: (s: number) => { status = s; return res; },
    json: () => res,
  } as unknown as Response;
  let called = false;
  const next: NextFunction = () => { called = true; };
  require2FA({ user } as unknown as AuthenticatedRequest, res, next);
  return { status, called };
};

describe('require2FA как гейт записи в «Реквизиты»', () => {
  it('2FA не включена → проходит (основной случай: так у всех кадровиков)', () => {
    const r = run({ two_factor_enabled: false, two_factor_verified: false });
    expect(r.called).toBe(true);
    expect(r.status).toBe(200);
  });

  it('2FA включена, сессия не подтверждена → 403', () => {
    const r = run({ two_factor_enabled: true, two_factor_verified: false });
    expect(r.status).toBe(403);
    expect(r.called).toBe(false);
  });

  it('2FA включена и подтверждена → проходит', () => {
    expect(run({ two_factor_enabled: true, two_factor_verified: true }).called).toBe(true);
  });

  it('нет пользователя → 401', () => {
    expect(run(null).status).toBe(401);
  });
});

/**
 * Контракт: гейт не должен «отвалиться» при будущих правках роутера — каждый
 * пишущий HR-маршрут обязан нести require2FA в своём стеке.
 */
describe('контракт роутера /api/hr-profiles', () => {
  interface ILayer {
    route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown; name: string }> };
  }
  const layers = (hrRouter as unknown as { stack: ILayer[] }).stack;

  const stackOf = (method: string, path: string): Array<{ handle: unknown; name: string }> => {
    const found = layers.find(l => l.route?.path === path && l.route.methods[method]);
    if (!found?.route) throw new Error(`маршрут ${method.toUpperCase()} ${path} не найден`);
    return found.route.stack;
  };

  const WRITE_ROUTES: Array<[string, string]> = [
    ['post', '/:employeeId/documents'],
    ['post', '/documents/:id/recognize'],
    ['delete', '/documents/:id'],
    ['get', '/documents/:id/content'],
    ['get', '/:employeeId/sensitive'],
    ['put', '/:employeeId'],
    ['post', '/drafts'],
    ['post', '/drafts/:draftId/documents'],
    ['post', '/drafts/:draftId/attach'],
    ['post', '/ocr-conflicts/:id/apply'],
    ['patch', '/:employeeId/zup'],
    ['get', '/export/zup'],
  ];

  it.each(WRITE_ROUTES)('%s %s защищён require2FA', (method, path) => {
    expect(stackOf(method, path).some(l => l.handle === require2FA)).toBe(true);
  });

  it('чтение профиля идёт без require2FA (нужен только view)', () => {
    expect(stackOf('get', '/:employeeId').some(l => l.handle === require2FA)).toBe(false);
  });
});
