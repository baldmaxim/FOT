import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Маршруты файлов шаблона графика (миграция 376) на настоящем роутере /api/schedules:
 * смотреть — право view, прикреплять и удалять — edit; право проверяется ДО приёма файла (multer),
 * и правка файлов не сбрасывает кэши табеля (маршруты стоят до middleware сброса).
 * Права подменены: уровень доступа задаёт заголовок x-test-level.
 */

const h = vi.hoisted(() => {
  const calls: string[] = [];
  const stubController = (name: string) => new Proxy({}, {
    get: (_target, key) => (req: { file?: { size: number } }, res: { json: (body: unknown) => void }) => {
      calls.push(`${name}.${String(key)}${req.file ? `:file=${req.file.size}` : ''}`);
      res.json({ success: true, data: [] });
    },
  });
  return { calls, stubController, invalidate: vi.fn() };
});

vi.mock('../middleware/auth.js', () => ({
  authenticate: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { id: 'user-1' };
    next();
  },
  requireAnyPageAccess: (pages: string[], level: 'view' | 'edit' = 'view') =>
    (req: { headers: Record<string, string | undefined> }, res: { status: (code: number) => { json: (body: unknown) => void } }, next: () => void) => {
      // x-test-page — страница, к которой у пользователя есть доступ (по умолчанию шаблоны графиков).
      const page = req.headers['x-test-page'] ?? '/admin/schedules/templates';
      const granted = req.headers['x-test-level'];
      const ok = pages.includes(page) && (granted === 'edit' || (granted === 'view' && level === 'view'));
      if (ok) {
        next();
        return;
      }
      res.status(403).json({ success: false, error: 'Нет доступа' });
    },
}));
vi.mock('../middleware/cacheResponse.js', () => ({ invalidateCaches: h.invalidate }));
vi.mock('../controllers/schedule-files.controller.js', () => ({ scheduleFilesController: h.stubController('files') }));
vi.mock('../controllers/schedule.controller.js', () => ({ scheduleController: h.stubController('schedule') }));
vi.mock('../controllers/schedule-export.controller.js', () => ({ scheduleExportController: h.stubController('export') }));

import scheduleRoutes from '../routes/schedule.routes.js';

const app = express();
app.use(express.json());
app.use('/api/schedules', scheduleRoutes);

const ID = '6f1c2d3e-4b5a-4c6d-8e7f-90a1b2c3d4e5';
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64)]);

beforeEach(() => {
  h.calls.length = 0;
  h.invalidate.mockClear();
});

describe('файлы графика: право view', () => {
  it('список и ссылка открыты, без кэша браузера', async () => {
    const list = await request(app).get(`/api/schedules/${ID}/files`).set('x-test-level', 'view');
    expect(list.status).toBe(200);
    expect(list.headers['cache-control']).toBe('no-store');
    const url = await request(app).get(`/api/schedules/${ID}/files/7/url?disposition=inline`).set('x-test-level', 'view');
    expect(url.status).toBe(200);
    expect(url.headers['cache-control']).toBe('no-store');
    expect(h.calls).toEqual(['files.list', 'files.fileUrl']);
  });

  it('прикрепить и удалить нельзя', async () => {
    const upload = await request(app).post(`/api/schedules/${ID}/files`).set('x-test-level', 'view')
      .attach('file', PDF, 'Приказ.pdf');
    expect(upload.status).toBe(403);
    const del = await request(app).delete(`/api/schedules/${ID}/files/7`).set('x-test-level', 'view');
    expect(del.status).toBe(403);
    expect(h.calls).toEqual([]);
  });

  it('право проверяется до приёма файла: больше 25 МБ без права — 403, а не 413', async () => {
    const big = Buffer.alloc(26 * 1024 * 1024, 1);
    const res = await request(app).post(`/api/schedules/${ID}/files`).set('x-test-level', 'view')
      .attach('file', big, 'big.pdf');
    expect(res.status).toBe(403);
  });

  it('без доступа к разделу — 403 и на чтение', async () => {
    const res = await request(app).get(`/api/schedules/${ID}/files`);
    expect(res.status).toBe(403);
  });

  it('«Управление кадрами» без раздела графиков: список шаблонов есть, файлов — нет', async () => {
    const templates = await request(app).get('/api/schedules').set('x-test-page', '/staff-control').set('x-test-level', 'edit');
    expect(templates.status).toBe(200);
    const files = await request(app).get(`/api/schedules/${ID}/files`).set('x-test-page', '/staff-control').set('x-test-level', 'edit');
    expect(files.status).toBe(403);
    const upload = await request(app).post(`/api/schedules/${ID}/files`).set('x-test-page', '/staff-control').set('x-test-level', 'edit')
      .attach('file', PDF, 'Приказ.pdf');
    expect(upload.status).toBe(403);
    expect(h.calls).toEqual(['schedule.list']);
  });
});

describe('файлы графика: право edit', () => {
  it('прикрепить: файл принят multer и передан контроллеру', async () => {
    const res = await request(app).post(`/api/schedules/${ID}/files`).set('x-test-level', 'edit')
      .attach('file', PDF, 'Приказ.pdf');
    expect(res.status).toBe(200);
    expect(h.calls).toEqual([`files.upload:file=${PDF.length}`]);
  });

  it('больше 25 МБ — 413 от multer, контроллер не вызывается', async () => {
    const big = Buffer.alloc(26 * 1024 * 1024, 1);
    const res = await request(app).post(`/api/schedules/${ID}/files`).set('x-test-level', 'edit')
      .attach('file', big, 'big.pdf');
    expect(res.status).toBe(413);
    expect(h.calls).toEqual([]);
  });

  it('удалить', async () => {
    const res = await request(app).delete(`/api/schedules/${ID}/files/7`).set('x-test-level', 'edit');
    expect(res.status).toBe(200);
    expect(h.calls).toEqual(['files.remove']);
  });
});

describe('кэши табеля', () => {
  it('прикрепление и удаление файла кэши табеля не сбрасывают', async () => {
    await request(app).post(`/api/schedules/${ID}/files`).set('x-test-level', 'edit').attach('file', PDF, 'Приказ.pdf');
    await request(app).delete(`/api/schedules/${ID}/files/7`).set('x-test-level', 'edit');
    expect(h.invalidate).not.toHaveBeenCalled();
  });

  it('правка самого шаблона по-прежнему сбрасывает', async () => {
    const res = await request(app).put(`/api/schedules/${ID}`).set('x-test-level', 'edit').send({ name: 'ИТР 5/2' });
    expect(res.status).toBe(200);
    expect(h.invalidate).toHaveBeenCalled();
  });
});
