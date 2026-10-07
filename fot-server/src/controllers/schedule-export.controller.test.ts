/**
 * POST /schedules/templates/export: снимок таблицы «Шаблоны графиков» → xlsx. Сервер данных не
 * читает, поэтому стережём форму снимка, лист и порядок строк.
 */
import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';

import { scheduleExportController } from './schedule-export.controller.js';

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
  title: 'Шаблоны графиков',
  subtitle: 'Дата выгрузки: 07.10.2026',
  file_name: 'Шаблоны графиков_2026-10-07.xlsx',
  columns: [
    { label: '№', type: 'int' },
    { label: 'Название', type: 'text' },
    { label: 'Ритм', type: 'text' },
  ],
  rows: [
    { cells: [1, '2/2 мониторинг', '2/2'] },
    { cells: [2, '5+0 (дефолт)', '5/2'] },
  ],
});

describe('scheduleExportController.exportTemplates', () => {
  it('отдаёт xlsx: лист «Шаблоны графиков», строки в порядке снимка', async () => {
    const { res, out } = makeRes();
    await scheduleExportController.exportTemplates(req(validBody()), res);

    expect(out.status).toBe(200);
    expect(out.headers['Content-Type']).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(decodeURIComponent(out.headers['Content-Disposition']))
      .toContain(`filename*=UTF-8''Шаблоны графиков_2026-10-07.xlsx`);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(out.body as never);
    const ws = workbook.getWorksheet('Шаблоны графиков');
    expect(ws).toBeDefined();
    expect(ws?.getCell('A1').value).toBe('Шаблоны графиков');
    expect(ws?.getRow(3).values).toEqual([undefined, '№', 'Название', 'Ритм']);
    expect(ws?.getRow(4).values).toEqual([undefined, 1, '2/2 мониторинг', '2/2']);
    expect(ws?.getRow(5).values).toEqual([undefined, 2, '5+0 (дефолт)', '5/2']);
  });

  it('пустая таблица → 400 с текстом ошибки', async () => {
    const { res, out } = makeRes();
    await scheduleExportController.exportTemplates(req({ ...validBody(), rows: [] }), res);
    expect(out.status).toBe(400);
    expect(out.body).toEqual({ success: false, error: 'Нет строк для выгрузки' });
  });

  it('число ячеек не совпадает со столбцами → 400', async () => {
    const { res, out } = makeRes();
    await scheduleExportController.exportTemplates(
      req({ ...validBody(), rows: [{ cells: [1, '2/2 мониторинг'] }] }),
      res,
    );
    expect(out.status).toBe(400);
  });
});
