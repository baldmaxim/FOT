import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Служебные записки к записи чёрного списка (миграция 274).
 *
 * Работает настоящий blacklist-memos.service поверх stateful-фейка БД: так
 * проверяется не «какой SQL отправили», а поведение — идемпотентность, порядок
 * лока и чтения, откат транзакции, гонка с удалением.
 */

interface IMemoRow {
  id: string;
  blacklist_id: string;
  file_name: string;
  file_size: number;
  mime_type: string;
  sha256: string;
  r2_key: string;
  uploaded_by: string | null;
  uploaded_by_name: string;
  created_at: string;
  deleted_at: string | null;
  deleted_by_name: string | null;
}

const h = vi.hoisted(() => ({
  db: {
    memos: [] as IMemoRow[],
    entries: new Set<string>(),
    log: [] as string[],
    failInsertOnce: false,
    seq: 0,
  },
  r2: {
    enabled: true,
    uploadObject: vi.fn(),
    deleteObject: vi.fn(),
    generateDownloadUrl: vi.fn(),
  },
  audit: vi.fn(),
}));

const pick = (row: IMemoRow) => ({
  id: row.id, blacklist_id: row.blacklist_id, file_name: row.file_name, file_size: row.file_size,
  mime_type: row.mime_type, sha256: row.sha256, r2_key: row.r2_key,
  uploaded_by_name: row.uploaded_by_name, created_at: row.created_at,
});

const fakeClient = {
  query: async (sql: string, params: unknown[] = []) => {
    const db = h.db;
    if (sql.includes('pg_advisory_xact_lock')) {
      db.log.push(`LOCK:${String(params[0])}`);
      return { rows: [] };
    }
    if (sql.includes('INSERT INTO public.person_blacklist_memos')) {
      db.log.push('INSERT');
      if (db.failInsertOnce) {
        db.failInsertOnce = false;
        throw new Error('db down');
      }
      const [entryId, fileName, fileSize, mime, sha, key, uploadedBy, uploadedByName] = params as [
        string, string, number, string, string, string, string | null, string];
      const active = db.memos.find(m => m.blacklist_id === entryId && m.sha256 === sha && !m.deleted_at);
      if (active) return { rows: [] };
      db.seq += 1;
      const row: IMemoRow = {
        id: `00000000-0000-4000-8000-${String(db.seq).padStart(12, '0')}`,
        blacklist_id: entryId, file_name: fileName, file_size: fileSize, mime_type: mime,
        sha256: sha, r2_key: key, uploaded_by: uploadedBy, uploaded_by_name: uploadedByName,
        created_at: new Date(Date.now() + db.seq).toISOString(), deleted_at: null, deleted_by_name: null,
      };
      db.memos.push(row);
      return { rows: [pick(row)] };
    }
    if (sql.includes('SELECT sha256 FROM public.person_blacklist_memos')) {
      const row = db.memos.find(m => m.id === params[0] && m.blacklist_id === params[1]);
      return { rows: row ? [{ sha256: row.sha256 }] : [] };
    }
    if (sql.includes('FOR UPDATE')) {
      db.log.push('READ_FOR_UPDATE');
      const row = db.memos.find(m => m.id === params[0] && m.blacklist_id === params[1]);
      return { rows: row ? [{ ...pick(row), deleted_at: row.deleted_at }] : [] };
    }
    if (sql.includes('UPDATE public.person_blacklist_memos')) {
      const row = db.memos.find(m => m.id === params[0] && !m.deleted_at);
      if (row) {
        row.deleted_at = new Date().toISOString();
        row.deleted_by_name = String(params[2]);
      }
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes('sha256 = $2 AND deleted_at IS NULL')) {
      db.log.push('FIND_ACTIVE');
      const row = db.memos.find(m => m.blacklist_id === params[0] && m.sha256 === params[1] && !m.deleted_at);
      return { rows: row ? [pick(row)] : [] };
    }
    throw new Error(`Неожиданный SQL в тесте: ${sql.slice(0, 80)}`);
  },
};

vi.mock('../config/postgres.js', () => ({
  query: vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM public.person_blacklist_memos')) {
      return h.db.memos
        .filter(m => m.blacklist_id === params[0] && !m.deleted_at)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .map(pick);
    }
    return [];
  }),
  queryOne: vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM public.person_blacklist WHERE id')) {
      return h.db.entries.has(String(params[0])) ? { id: params[0] } : null;
    }
    return null;
  }),
  execute: vi.fn(),
  // Настоящая семантика транзакции: исключение откатывает изменения.
  withTransaction: vi.fn(async (fn: (client: typeof fakeClient) => Promise<unknown>) => {
    const snapshot = h.db.memos.map(m => ({ ...m }));
    try {
      return await fn(fakeClient);
    } catch (error) {
      h.db.memos = snapshot;
      throw error;
    }
  }),
}));

vi.mock('../services/r2.service.js', () => ({
  r2Service: {
    isEnabledAsync: vi.fn(async () => h.r2.enabled),
    generateBlacklistMemoKey: (entryId: string, sha: string, name: string) =>
      `blacklist/${entryId}/${sha}${path.extname(name).toLowerCase() || '.bin'}`,
    uploadObject: h.r2.uploadObject,
    deleteObject: h.r2.deleteObject,
    generateDownloadUrl: h.r2.generateDownloadUrl,
  },
}));
vi.mock('../services/audit.service.js', () => ({
  auditService: { logFromRequestWithClient: h.audit, logFromRequest: vi.fn() },
}));
vi.mock('../services/audit-context.helpers.js', () => ({
  loadUserFullName: vi.fn(async () => 'Гладкая Наталья Васильевна'),
}));
vi.mock('../services/blacklist-sigur.scheduler.js', () => ({ kickBlacklistSigur: vi.fn() }));
vi.mock('../socket/io-instance.js', () => ({ disconnectUserSockets: vi.fn() }));

const { adminBlacklistController } = await import('./admin-blacklist.controller.js');

const ENTRY = '11111111-1111-4111-8111-111111111111';
const OTHER_ENTRY = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';

const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('служебная записка №1')]);
const PDF_2 = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('служебная записка №2')]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const sha = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');

/** Как multer отдаёт кириллическое имя: UTF-8 байты, прочитанные как latin1. */
const multerName = (name: string) => Buffer.from(name, 'utf8').toString('latin1');

const makeRes = () => ({
  statusCode: 200,
  body: undefined as unknown as Record<string, unknown>,
  status(code: number) { this.statusCode = code; return this; },
  json(payload: Record<string, unknown>) { this.body = payload; return this; },
});

const uploadReq = (buffer: Buffer, name: string, mimetype: string, entryId = ENTRY) => ({
  params: { entryId },
  file: { originalname: multerName(name), buffer, size: buffer.length, mimetype },
  user: { id: USER },
  headers: {}, ip: '127.0.0.1', socket: {},
}) as never;

const upload = async (buffer: Buffer, name = 'записка.pdf', mimetype = 'application/pdf', entryId = ENTRY) => {
  const res = makeRes();
  await adminBlacklistController.uploadMemo(uploadReq(buffer, name, mimetype, entryId), res as never);
  return res;
};

const remove = async (memoId: string, entryId = ENTRY) => {
  const res = makeRes();
  await adminBlacklistController.removeMemo(
    { params: { entryId, memoId }, user: { id: USER }, headers: {}, ip: '127.0.0.1', socket: {} } as never,
    res as never,
  );
  return res;
};

const activeMemos = () => h.db.memos.filter(m => !m.deleted_at);

beforeEach(() => {
  vi.clearAllMocks();
  h.db.memos = [];
  h.db.entries = new Set([ENTRY]);
  h.db.log = [];
  h.db.failInsertOnce = false;
  h.db.seq = 0;
  h.r2.enabled = true;
  h.r2.uploadObject.mockResolvedValue(undefined);
  h.r2.generateDownloadUrl.mockImplementation(async (key: string, _name: string, disposition = 'attachment') =>
    `https://r2.example/${key}?d=${disposition}`);
  h.audit.mockResolvedValue(undefined);
});

describe('загрузка: проверки до записи', () => {
  it('R2 не настроен → 503, ничего не пишется', async () => {
    h.r2.enabled = false;
    const res = await upload(PDF);
    expect(res.statusCode).toBe(503);
    expect(h.r2.uploadObject).not.toHaveBeenCalled();
    expect(h.db.memos).toHaveLength(0);
  });

  it('запись ЧС не найдена → 404, R2 не трогается', async () => {
    const res = await upload(PDF, 'записка.pdf', 'application/pdf', OTHER_ENTRY);
    expect(res.statusCode).toBe(404);
    expect(h.r2.uploadObject).not.toHaveBeenCalled();
  });

  it('недопустимый тип (HTML под видом PDF) → 400, R2 не трогается', async () => {
    const res = await upload(Buffer.from('<!DOCTYPE html><html></html>'), 'записка.pdf', 'application/pdf');
    expect(res.statusCode).toBe(400);
    expect(h.r2.uploadObject).not.toHaveBeenCalled();
    expect(h.db.memos).toHaveLength(0);
  });

  it('файл не передан → 400', async () => {
    const res = makeRes();
    await adminBlacklistController.uploadMemo(
      { params: { entryId: ENTRY }, user: { id: USER }, headers: {}, socket: {} } as never,
      res as never,
    );
    expect(res.statusCode).toBe(400);
  });
});

describe('загрузка: успешный путь', () => {
  it('детерминированный ключ, декодированное имя, MIME сервера, аудит один раз тем же клиентом', async () => {
    const res = await upload(PNG, 'скан служебной.png', 'application/octet-stream');

    expect(res.statusCode).toBe(200);
    expect(res.body.created).toBe(true);
    const key = `blacklist/${ENTRY}/${sha(PNG)}.png`;
    expect(h.r2.uploadObject).toHaveBeenCalledWith(key, PNG, 'image/png');
    expect(activeMemos()).toHaveLength(1);
    expect(activeMemos()[0]).toMatchObject({
      file_name: 'скан служебной.png', mime_type: 'image/png', r2_key: key,
      uploaded_by: USER, uploaded_by_name: 'Гладкая Наталья Васильевна',
    });
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][0]).toBe(fakeClient);
    expect(h.audit.mock.calls[0][3]).toBe('BLACKLIST_MEMO_ADDED');
  });

  it('проверка «уже есть» идёт только после лока — незаблокированного быстрого пути нет', async () => {
    await upload(PDF);
    const lockIndex = h.db.log.findIndex(entry => entry.startsWith('LOCK:'));
    const findIndex = h.db.log.indexOf('FIND_ACTIVE');
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(findIndex).toBeGreaterThan(lockIndex);
    expect(h.db.log[lockIndex]).toBe(`LOCK:blacklist:memo:${ENTRY}:${sha(PDF)}`);
  });
});

describe('идемпотентность загрузки', () => {
  it('тот же файл второй раз → created=false, второй строки и аудита нет', async () => {
    await upload(PDF);
    const again = await upload(PDF);

    expect(again.statusCode).toBe(200);
    expect(again.body.created).toBe(false);
    expect(h.db.memos).toHaveLength(1);
    expect(h.audit).toHaveBeenCalledTimes(1);
  });

  it('разные файлы с одинаковым именем → две записки', async () => {
    await upload(PDF, 'записка.pdf');
    await upload(PDF_2, 'записка.pdf');
    expect(activeMemos()).toHaveLength(2);
    expect(new Set(activeMemos().map(m => m.r2_key)).size).toBe(2);
  });

  it('конфликт вставки (параллельный запрос вне лока) → существующая записка, не 500', async () => {
    await upload(PDF);
    // Имитируем параллельный запрос, который прошёл лок до нас: активная строка уже
    // есть, но наш FIND_ACTIVE её «не увидел». Сработать должна страховка ON CONFLICT.
    const original = fakeClient.query;
    let skipped = false;
    fakeClient.query = async (sql: string, params: unknown[] = []) => {
      if (!skipped && sql.includes('sha256 = $2 AND deleted_at IS NULL')) {
        skipped = true;
        return { rows: [] };
      }
      return original(sql, params);
    };
    try {
      const res = await upload(PDF);
      expect(res.statusCode).toBe(200);
      expect(res.body.created).toBe(false);
      expect(h.db.memos).toHaveLength(1);
    } finally {
      fakeClient.query = original;
    }
  });

  it('гонка с удалением: записку удалили до входа в лок → загрузка создаёт новую, а не отвечает created=false', async () => {
    await upload(PDF);
    const firstId = activeMemos()[0].id;
    // Удаление завершилось, пока шла загрузка в R2 — т.е. до лока загрузки.
    h.r2.uploadObject.mockImplementationOnce(async () => {
      await remove(firstId);
    });

    const res = await upload(PDF);

    expect(res.body.created).toBe(true);
    expect(activeMemos()).toHaveLength(1);
    expect(activeMemos()[0].id).not.toBe(firstId);
  });

  it('вставка в БД упала → объект R2 не удаляется; повтор создаёт строку с тем же ключом', async () => {
    h.db.failInsertOnce = true;
    const failed = await upload(PDF);

    expect(failed.statusCode).toBe(500);
    expect(h.r2.deleteObject).not.toHaveBeenCalled();
    expect(h.db.memos).toHaveLength(0);

    const retry = await upload(PDF);
    expect(retry.body.created).toBe(true);
    expect(h.r2.uploadObject.mock.calls[0][0]).toBe(h.r2.uploadObject.mock.calls[1][0]);
    expect(activeMemos()).toHaveLength(1);
  });

  it('сбой записи аудита откатывает строку — записки без следа не бывает', async () => {
    h.audit.mockRejectedValueOnce(new Error('audit down'));
    const res = await upload(PDF);

    expect(res.statusCode).toBe(500);
    expect(h.db.memos).toHaveLength(0);
    expect(h.r2.deleteObject).not.toHaveBeenCalled();
  });
});

describe('список', () => {
  it('подписывает ссылки: preview только для PDF и изображений, удалённые не возвращаются', async () => {
    const docx = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('word/document.xml'), Buffer.alloc(16)]);
    await upload(PDF, 'записка.pdf');
    await upload(docx, 'акт.docx', 'application/octet-stream');
    await upload(PNG, 'скан.png', 'image/png');
    const scan = activeMemos().find(m => m.file_name === 'скан.png');
    await remove(String(scan?.id));

    const res = makeRes();
    await adminBlacklistController.listMemos({ params: { entryId: ENTRY } } as never, res as never);

    const data = res.body.data as Array<{ file_name: string; preview_url: string | null; download_url: string }>;
    expect(data.map(d => d.file_name).sort()).toEqual(['акт.docx', 'записка.pdf']);
    expect(data.find(d => d.file_name === 'записка.pdf')?.preview_url).toContain('d=inline');
    expect(data.find(d => d.file_name === 'акт.docx')?.preview_url).toBeNull();
    expect(data.every(d => d.download_url.includes('d=attachment'))).toBe(true);
  });
});

describe('удаление', () => {
  it('берёт тот же лок, что загрузка, и перечитывает строку внутри него', async () => {
    await upload(PDF);
    const memoId = activeMemos()[0].id;
    h.db.log = [];

    await remove(memoId);

    const lockIndex = h.db.log.findIndex(entry => entry.startsWith('LOCK:'));
    expect(h.db.log[lockIndex]).toBe(`LOCK:blacklist:memo:${ENTRY}:${sha(PDF)}`);
    expect(h.db.log.indexOf('READ_FOR_UPDATE')).toBeGreaterThan(lockIndex);
  });

  it('чужая записка (другая запись) → 404, ничего не меняется', async () => {
    await upload(PDF);
    const memoId = activeMemos()[0].id;
    const res = await remove(memoId, OTHER_ENTRY);
    expect(res.statusCode).toBe(404);
    expect(activeMemos()).toHaveLength(1);
  });

  it('повторное удаление → changed=false, второй аудит не пишется, R2 не трогается', async () => {
    await upload(PDF);
    const memoId = activeMemos()[0].id;
    h.audit.mockClear();

    const first = await remove(memoId);
    const second = await remove(memoId);

    expect(first.body.changed).toBe(true);
    expect(second.body.changed).toBe(false);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][3]).toBe('BLACKLIST_MEMO_REMOVED');
    expect(h.r2.deleteObject).not.toHaveBeenCalled();
  });

  it('тот же файл после удаления → новая записка на тот же объект R2', async () => {
    await upload(PDF);
    const first = activeMemos()[0];
    await remove(first.id);

    const res = await upload(PDF);

    expect(res.body.created).toBe(true);
    expect(activeMemos()).toHaveLength(1);
    expect(activeMemos()[0].id).not.toBe(first.id);
    expect(activeMemos()[0].r2_key).toBe(first.r2_key);
  });
});

describe('приём файла и защита маршрутов', () => {
  it('файл больше 25 МБ → 413 с понятным текстом, обработчик не вызывается', async () => {
    const { acceptMemoFile } = await import('../middleware/blacklistMemoUpload.js');
    const handler = vi.fn((_req: express.Request, res: express.Response) => { res.json({ ok: true }); });
    const app = express();
    app.post('/memo', acceptMemoFile, handler);

    const res = await request(app)
      .post('/memo')
      .attach('file', Buffer.alloc(25 * 1024 * 1024 + 1), 'большой.pdf');

    expect(res.status).toBe(413);
    expect(res.body.error).toContain('25 МБ');
    expect(handler).not.toHaveBeenCalled();
  });

  it('файл в пределах лимита доходит до обработчика', async () => {
    const { acceptMemoFile } = await import('../middleware/blacklistMemoUpload.js');
    const app = express();
    app.post('/memo', acceptMemoFile, (req, res) => { res.json({ size: req.file?.size ?? 0 }); });

    const res = await request(app).post('/memo').attach('file', PDF, 'записка.pdf');

    expect(res.status).toBe(200);
    expect(res.body.size).toBe(PDF.length);
  });

  it('загрузка и удаление записки защищены 2FA, причём 2FA стоит до приёма файла', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const routes = readFileSync(path.resolve(here, '../routes/admin.routes.ts'), 'utf8');
    const uploadRoute = routes.split('\n').find(line => line.includes("router.post('/users/blacklist/:entryId/memos',"));
    const removeRoute = routes.split('\n').find(line => line.includes("'/users/blacklist/:entryId/memos/:memoId/remove'"));

    expect(uploadRoute).toBeDefined();
    expect(removeRoute).toBeDefined();
    expect(uploadRoute).toMatch(/requirePageAccess\('\/admin\/users', 'edit'\), requireCritical2FA, acceptMemoFile,/);
    expect(removeRoute).toContain('requireCritical2FA');
  });
});
