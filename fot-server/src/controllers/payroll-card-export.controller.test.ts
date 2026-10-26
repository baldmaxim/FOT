/**
 * POST /payroll/terms/card/export: снимок карточки сотрудника → xlsx из двух листов. Сервер данных
 * не читает — стережём форму снимка, листы книги и заголовки ответа.
 */
import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';

import { payrollCardExportController } from './payroll-card-export.controller.js';

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

const req = (body: unknown) => ({ body, user: { id: 'u-1' } }) as never;

const validBody = () => ({
  file_name: 'Зарплата_Иванов_Иван_2026-10-26.xlsx',
  sheets: [
    {
      title: 'Иванов Иван',
      subtitle: 'Монтажник · Условия на 26.10.2026',
      columns: [{ label: 'Показатель', type: 'text' }, { label: 'Значение', type: 'money' }],
      rows: [{ cells: ['Категория', 'Рабочие'] }, { cells: ['Итого, ₽/мес', 150000] }],
    },
    {
      title: 'История выплат',
      subtitle: 'Иванов Иван',
      columns: [
        { label: 'Месяц', type: 'text' },
        { label: 'Начислено', type: 'money' },
        { label: 'Удержано', type: 'money' },
        { label: 'К выплате', type: 'money' },
      ],
      rows: [{ cells: ['Выплат из 1С пока нет', null, null, null] }],
    },
  ],
});

describe('payrollCardExportController.exportCard', () => {
  it('отдаёт xlsx с листами «Условия» и «История выплат»', async () => {
    const { res, out } = makeRes();
    await payrollCardExportController.exportCard(req(validBody()), res);

    expect(out.status).toBe(200);
    expect(out.headers['Content-Type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(decodeURIComponent(out.headers['Content-Disposition']))
      .toContain(`filename*=UTF-8''Зарплата_Иванов_Иван_2026-10-26.xlsx`);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(out.body as never);
    expect(workbook.worksheets.map(ws => ws.name)).toEqual(['Условия', 'История выплат']);
    expect(workbook.getWorksheet('Условия')!.getCell('B5').value).toBe(150000);
  });

  it('один лист вместо двух → 400', async () => {
    const body = validBody();
    const { res, out } = makeRes();
    await payrollCardExportController.exportCard(req({ ...body, sheets: [body.sheets[0]] }), res);
    expect(out.status).toBe(400);
    expect(out.body).toEqual({ success: false, error: 'Неверное число листов' });
  });

  it('некорректная таблица и пустое тело → 400', async () => {
    const body = validBody();
    const broken = { ...body, sheets: [body.sheets[0], { ...body.sheets[1], rows: [{ cells: ['x'] }] }] };
    for (const payload of [broken, {}]) {
      const { res, out } = makeRes();
      await payrollCardExportController.exportCard(req(payload), res);
      expect(out.status).toBe(400);
    }
  });
});
