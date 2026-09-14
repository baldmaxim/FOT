import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

// Лимиты «Моя SIM» на настоящем express-rate-limit (прод-режим включён моком):
//  - POST /forwarding и /forwarding/delete не проходят через отдельный in-memory
//    лимитер: квота изменений считается в БД на уровне операции;
//  - глобальный apiLimiter при отказе пишет в лог своё имя и отдаёт code.

vi.mock('../config/features.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/features.js')>();
  return { ...actual, IS_PRODUCTION: true };
});
vi.mock('../middleware/auth.js', () => ({
  authenticate: (req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: unknown }).user = { id: 'u-1', employee_id: 42 };
    next();
  },
  requirePageAccess: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));
vi.mock('../controllers/employee-sim.controller.js', () => {
  const ok = (_req: Request, res: Response) => { res.status(202).json({ success: true }); };
  return {
    employeeSimController: {
      getMyNumbers: ok, getMySim: ok, getMyUsage: ok, getMyForwarding: ok, getMyForwardingStatus: ok,
      getMyForwardingOperation: ok, setMyForwarding: ok, deleteMyForwarding: ok,
    },
  };
});

process.env.API_RATE_LIMIT_MAX = '3';

const { apiLimiter } = await import('../middleware/rateLimit.js');
const employeeSimRoutes = (await import('../routes/employee-sim.routes.js')).default;

const makeApp = (withApiLimiter: boolean) => {
  const app = express();
  app.use(express.json());
  if (withApiLimiter) app.use('/api', apiLimiter);
  app.use('/api/my-sim', employeeSimRoutes);
  return app;
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('«Моя SIM»: лимиты переадресации', () => {
  it('POST /forwarding: 8 нажатий подряд — ни одного 429 от лимитера (квота в БД)', async () => {
    const app = makeApp(false);
    for (let i = 0; i < 8; i++) {
      const res = await request(app).post('/api/my-sim/forwarding').send({ type: 'CFU', target: '79161234567' });
      expect(res.status).toBe(202);
    }
  });

  it('POST /forwarding/delete: 8 нажатий подряд — ни одного 429 от лимитера', async () => {
    const app = makeApp(false);
    for (let i = 0; i < 8; i++) {
      const res = await request(app).post('/api/my-sim/forwarding/delete').send({ type: 'CFU' });
      expect(res.status).toBe(202);
    }
  });

  it('apiLimiter: сверх порога — 429 с code rate_limited_api и строкой [rate-limit] в логе', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const app = makeApp(true);
    for (let i = 0; i < 3; i++) {
      expect((await request(app).get('/api/my-sim/forwarding/operation')).status).toBe(202);
    }
    const res = await request(app).post('/api/my-sim/forwarding').send({ type: 'CFU', target: '79161234567' });

    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ success: false, code: 'rate_limited_api' });
    const line = warn.mock.calls.map(c => String(c[0])).find(l => l.startsWith('[rate-limit]'));
    expect(line).toContain('limiter=api');
    expect(line).toContain('POST /api/my-sim/forwarding');
    expect(line).not.toMatch(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
  });
});
