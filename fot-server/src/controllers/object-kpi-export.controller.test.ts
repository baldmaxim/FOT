/**
 * POST /object-kpi/report/export: снимок таблицы экрана → xlsx. Сервер данных не читает,
 * поэтому стережём форму снимка (лимиты, число ячеек, уникальные столбцы) и заголовки ответа.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../config/postgres.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));

import { objectKpiExportController, OBJECT_KPI_EXPORT_MAX_ROWS } from './object-kpi-export.controller.js';

const makeRes = () => {
  const out: { status?: number; body?: unknown; headers: Record<string, string> } = { headers: {} };
  const res = {
    headersSent: false,
    status(code: number) { out.status = code; return res; },
    json(body: unknown) { out.body = body; out.status = out.status ?? 200; return res; },
    setHeader(name: string, value: string) { out.headers[name] = value; return res; },
    send(body: unknown) { out.body = body; out.status = out.status ?? 200; return res; },
  };
  return { res: res as never, out };
};

const req = (body: unknown) => ({ body, user: { id: 'u-1', is_admin: true } }) as never;

const validBody = () => ({
  title: 'KPI объектов — Все объекты',
  subtitle: 'Период: август 2026. Все суммы — в рублях, с НДС.',
  file_name: 'KPI объектов_Все объекты_2026-08.xlsx',
  columns: [
    { label: '№', type: 'int' },
    { label: 'Объект', type: 'text' },
    { label: 'План', type: 'money' },
  ],
  rows: [{ cells: [1, 'ЖК Сад 69', '172143879.00'] }],
});

describe('objectKpiExportController.exportTable', () => {
  it('отдаёт xlsx с именем файла в Content-Disposition', async () => {
    const { res, out } = makeRes();
    await objectKpiExportController.exportTable(req(validBody()), res);

    expect(out.status).toBe(200);
    expect(out.headers['Content-Type']).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(decodeURIComponent(out.headers['Content-Disposition']))
      .toContain(`filename*=UTF-8''KPI объектов_Все объекты_2026-08.xlsx`);
    expect(Buffer.isBuffer(out.body)).toBe(true);
  });

  it('служебные символы в имени файла заменяются, расширение — ровно одно', async () => {
    const { res, out } = makeRes();
    await objectKpiExportController.exportTable(req({ ...validBody(), file_name: 'KPI: а/б*в' }), res);

    expect(decodeURIComponent(out.headers['Content-Disposition'])).toContain(`UTF-8''KPI_ а_б_в.xlsx`);
  });

  it('число ячеек не совпадает со столбцами → 400', async () => {
    const { res, out } = makeRes();
    await objectKpiExportController.exportTable(
      req({ ...validBody(), rows: [{ cells: [1, 'ЖК Сад 69'] }] }),
      res,
    );
    expect(out.status).toBe(400);
  });

  it('повтор названия столбца → 400 (умная таблица Excel не откроется)', async () => {
    const body = validBody();
    const { res, out } = makeRes();
    await objectKpiExportController.exportTable(
      req({ ...body, columns: [...body.columns.slice(0, 2), { label: 'Объект', type: 'money' }] }),
      res,
    );
    expect(out.status).toBe(400);
  });

  it('пустая таблица и сверх лимита строк → 400', async () => {
    for (const rows of [[], Array.from({ length: OBJECT_KPI_EXPORT_MAX_ROWS + 1 }, (_, i) => ({ cells: [i, 'x', null] }))]) {
      const { res, out } = makeRes();
      await objectKpiExportController.exportTable(req({ ...validBody(), rows }), res);
      expect(out.status).toBe(400);
    }
  });
});
