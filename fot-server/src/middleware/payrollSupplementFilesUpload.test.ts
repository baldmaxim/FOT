import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';

import { acceptSupplementFiles } from './payrollSupplementFilesUpload.js';
import { supplementFileName } from '../services/payroll/payroll-supplement-files.js';

// Приём файлов разовой доплаты: JSON проходит как есть, multipart — data + files; лимиты — до чтения в память.
const app = express();
app.use(express.json());
app.post('/one-time', acceptSupplementFiles, (req, res) => {
  const files = Array.isArray(req.files) ? req.files : null;
  res.json({ body: { ...req.body }, files: files?.map(file => ({ name: file.originalname, size: file.size })) ?? null });
});

describe('acceptSupplementFiles', () => {
  it('JSON (прежний клиент) — без multer', async () => {
    const res = await request(app).post('/one-time').send({ month: '2026-10' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ body: { month: '2026-10' }, files: null });
  });

  it('multipart: data и файлы; без файлов — пустой список', async () => {
    const res = await request(app).post('/one-time')
      .field('data', '{"month":"2026-10"}')
      .attach('files', Buffer.from('%PDF-1.4'), 'a.pdf')
      .attach('files', Buffer.from('%PDF-1.4'), 'b.pdf');
    expect(res.status).toBe(200);
    expect(res.body.body).toEqual({ data: '{"month":"2026-10"}' });
    expect(res.body.files).toEqual([{ name: 'a.pdf', size: 8 }, { name: 'b.pdf', size: 8 }]);

    const empty = await request(app).post('/one-time').field('data', '{}');
    expect(empty.body.files).toEqual([]);
  });

  it('11 файлов — 400 SUPPLEMENT_FILES_LIMIT; чужое поле файла — 400', async () => {
    let req = request(app).post('/one-time').field('data', '{}');
    for (let i = 0; i < 11; i += 1) req = req.attach('files', Buffer.from('x'), `f${i}.pdf`);
    const res = await req;
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('SUPPLEMENT_FILES_LIMIT');

    const other = await request(app).post('/one-time').attach('file', Buffer.from('x'), 'a.pdf');
    expect(other.status).toBe(400);
    expect(other.body.error).toBe('Некорректные данные формы');
  });

  it('Content-Length больше 50 МБ + 1 МБ на форму — 413 до чтения тела; без него — 411', async () => {
    const big = await request(app).post('/one-time')
      .set('Content-Type', 'multipart/form-data; boundary=x')
      .set('Content-Length', String(51 * 1024 * 1024 + 1))
      .send('');
    expect(big.status).toBe(413);
    expect(big.body.error).toBe('Не больше 50 МБ за одно сохранение');

    const chunked = await request(app).post('/one-time')
      .set('Content-Type', 'multipart/form-data; boundary=x')
      .set('Transfer-Encoding', 'chunked')
      .send('');
    expect(chunked.status).toBe(411);
  });
});

describe('supplementFileName', () => {
  it('длинное имя — не длиннее 200, расширение на месте; формула CSV обезврежена', () => {
    const name = supplementFileName(`${'Я'.repeat(400)}.docx`, '.docx');
    expect(name.length).toBeLessThanOrEqual(200);
    expect(name.endsWith('.docx')).toBe(true);

    // «-» остаётся в имени — sanitizeFileName ставит апостроф после обрезки основы.
    const formula = supplementFileName(`-${'A'.repeat(300)}.pdf`, '.pdf');
    expect(formula.startsWith("'-")).toBe(true);
    expect(formula.length).toBeLessThanOrEqual(200);
    expect(formula.endsWith('.pdf')).toBe(true);

    expect(supplementFileName('../../Приказ №5 (копия).pdf', '.pdf')).toBe('Приказ №5 (копия).pdf');
  });
});
