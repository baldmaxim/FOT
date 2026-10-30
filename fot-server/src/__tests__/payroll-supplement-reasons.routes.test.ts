import { beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';

/**
 * Основания разовой доплаты (миграция 340): список — с просмотром «Условий оплаты» (termsView), добавить,
 * переименовать, удалить — только с их правкой (termsEdit), не с правкой «Расчётов» (deductionsEdit).
 * audit:routes видит только наличие гарда, здесь — его смысл. Права — заглушка по уровню доступа к странице.
 */

type Level = 'view' | 'edit';

const h = vi.hoisted(() => ({
  grants: new Map<string, 'view' | 'edit'>(),
  calls: [] as string[],
}));

vi.mock('../config/postgres.js', () => ({
  query: vi.fn(async () => []),
  queryOne: vi.fn(async () => null),
  execute: vi.fn(async () => 0),
  withTransaction: vi.fn(),
  getPool: vi.fn(),
  pool: vi.fn(),
}));

vi.mock('../middleware/auth.js', async importOriginal => {
  const allows = (page: string, action: Level): boolean => {
    const granted = h.grants.get(page);
    return granted === 'edit' || (granted === 'view' && action === 'view');
  };
  const guard = (allowed: boolean, res: Response, next: NextFunction): void => {
    if (allowed) next();
    else res.status(403).json({ success: false });
  };
  return {
    ...(await importOriginal<typeof import('../middleware/auth.js')>()),
    authenticate: (req: Request, _res: Response, next: NextFunction) => {
      (req as Request & { user: unknown }).user = { id: 'user-1' };
      next();
    },
    requirePageAccess: (page: string, action: Level = 'view') =>
      (_req: Request, res: Response, next: NextFunction) => guard(allows(page, action), res, next),
    requireAnyPageAccess: (pages: string[], action: Level = 'view') =>
      (_req: Request, res: Response, next: NextFunction) => guard(pages.some(page => allows(page, action)), res, next),
  };
});

vi.mock('../controllers/payroll-supplement-reasons.controller.js', () => {
  const stub = (name: string) => (_req: Request, res: Response) => {
    h.calls.push(name);
    res.json({ success: true });
  };
  return {
    payrollSupplementReasonsController: { list: stub('list'), add: stub('add'), rename: stub('rename'), remove: stub('remove') },
  };
});

const app = express();
app.use(express.json());
app.use('/api/payroll', (await import('../routes/payroll.routes.js')).default);

const URL = '/api/payroll/supplement-reasons';
const statuses = async () => ({
  list: (await request(app).get(URL)).status,
  add: (await request(app).post(URL).send({ name: 'Премия' })).status,
  rename: (await request(app).patch(`${URL}/1`).send({ name: 'Премия' })).status,
  remove: (await request(app).delete(`${URL}/1`)).status,
});

beforeEach(() => {
  h.grants.clear();
  h.calls.length = 0;
});

describe('основания разовой доплаты: права маршрутов', () => {
  it('без доступа к «Условиям оплаты» — 403 на всё', async () => {
    expect(await statuses()).toEqual({ list: 403, add: 403, rename: 403, remove: 403 });
    expect(h.calls).toEqual([]);
  });

  it('просмотр «Условий оплаты» — список есть, правки 403', async () => {
    h.grants.set('/salary/terms', 'view');
    expect(await statuses()).toEqual({ list: 200, add: 403, rename: 403, remove: 403 });
    expect(h.calls).toEqual(['list']);
  });

  it('правка только «Расчётов» (/salary/payments) — не правит основания', async () => {
    h.grants.set('/salary/payments', 'edit');
    expect(await statuses()).toEqual({ list: 403, add: 403, rename: 403, remove: 403 });
  });

  it('правка «Условий оплаты» — всё доступно', async () => {
    h.grants.set('/salary/terms', 'edit');
    expect(await statuses()).toEqual({ list: 200, add: 200, rename: 200, remove: 200 });
    expect(h.calls).toEqual(['list', 'add', 'rename', 'remove']);
  });
});
