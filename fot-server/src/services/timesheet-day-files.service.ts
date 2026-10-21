import { query, queryOne, withTransaction } from '../config/postgres.js';

// «Файлы дня» — вложения кадрового админа к дню сотрудника, без привязки к корректировке.
// documents.employee_id = NULL: файл не попадает в «Мои документы» и карточку сотрудника,
// общий /documents/:id/download и DELETE /documents/:id его не отдают — только эндпоинты дня.
export const DAY_FILE_ENTITY_TYPE = 'timesheet_day';
export const DAY_FILE_PURPOSE = 'timesheet_day_file';
// Существующая категория (миграция 157): отдельная потребовала бы миграцию.
const DAY_FILE_CATEGORY = 'timesheet_correction';

export interface ITimesheetDayFile {
  id: number;
  original_name: string;
  mime_type: string | null;
  file_size: number;
  uploaded_at: string;
  uploader_name: string | null;
  r2_key: string;
}

export const dayFileEntityId = (employeeId: number, workDate: string): string => `${employeeId}|${workDate}`;

interface IDayFileRow {
  id: number | string;
  file_name: string;
  mime_type: string | null;
  file_size: number | string;
  created_at: string | Date;
  uploader_name: string | null;
  r2_key: string;
}

const mapRow = (row: IDayFileRow): ITimesheetDayFile => ({
  id: Number(row.id),
  original_name: String(row.file_name),
  mime_type: row.mime_type ? String(row.mime_type) : null,
  file_size: Number(row.file_size),
  uploaded_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  uploader_name: row.uploader_name ?? null,
  r2_key: String(row.r2_key),
});

/** Связь хранится строкой без FK — существование сотрудника проверяем явно. */
export async function employeeExists(employeeId: number): Promise<boolean> {
  const row = await queryOne<{ id: number }>(`SELECT id FROM employees WHERE id = $1`, [employeeId]);
  return row != null;
}

export async function listDayFiles(employeeId: number, workDate: string): Promise<ITimesheetDayFile[]> {
  const rows = await query<IDayFileRow>(
    `SELECT d.id, d.file_name, d.mime_type, d.file_size, d.created_at, d.r2_key, up.full_name AS uploader_name
       FROM document_links dl
       JOIN documents d ON d.id = dl.document_id
       LEFT JOIN user_profiles up ON up.id = d.uploaded_by
      WHERE dl.entity_type = $1 AND dl.entity_id = $2 AND dl.purpose = $3
        AND d.deleted_at IS NULL
      ORDER BY d.created_at DESC, d.id DESC`,
    [DAY_FILE_ENTITY_TYPE, dayFileEntityId(employeeId, workDate), DAY_FILE_PURPOSE],
  );
  return rows.map(mapRow);
}

export async function createDayFile(params: {
  employeeId: number;
  workDate: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  r2Key: string;
  uploadedBy: string;
}): Promise<ITimesheetDayFile> {
  return withTransaction(async (client) => {
    const result = await client.query<IDayFileRow>(
      `INSERT INTO documents
         (employee_id, leave_request_id, category, file_name, file_size, mime_type, r2_key, uploaded_by)
       VALUES (NULL, NULL, $1, $2, $3, $4, $5, $6)
       RETURNING id, file_name, mime_type, file_size, created_at, r2_key, NULL::text AS uploader_name`,
      [DAY_FILE_CATEGORY, params.fileName, params.fileSize, params.mimeType, params.r2Key, params.uploadedBy],
    );
    const doc = result.rows[0];
    if (!doc) throw new Error('Failed to insert document');

    await client.query(
      `INSERT INTO document_links (document_id, entity_type, entity_id, purpose)
         VALUES ($1, $2, $3, $4)`,
      [doc.id, DAY_FILE_ENTITY_TYPE, dayFileEntityId(params.employeeId, params.workDate), DAY_FILE_PURPOSE],
    );
    return mapRow(doc);
  });
}

/** Сотрудник и дата файла дня — по точной ссылке timesheet_day; null, если это не файл дня. */
export async function loadDayFileLink(
  documentId: number,
): Promise<{ employeeId: number; workDate: string } | null> {
  const row = await queryOne<{ entity_id: string }>(
    `SELECT dl.entity_id
       FROM document_links dl
       JOIN documents d ON d.id = dl.document_id
      WHERE dl.document_id = $1 AND dl.entity_type = $2 AND dl.purpose = $3
        AND d.deleted_at IS NULL
      LIMIT 1`,
    [documentId, DAY_FILE_ENTITY_TYPE, DAY_FILE_PURPOSE],
  );
  if (!row) return null;
  const [empRaw, workDate] = String(row.entity_id).split('|');
  const employeeId = Number(empRaw);
  if (!Number.isInteger(employeeId) || employeeId <= 0 || !workDate) return null;
  return { employeeId, workDate };
}

/**
 * Удаляет файл дня. Документ блокируется, ссылки перепроверяются в той же транзакции:
 * появилась любая ссылка не «файл дня» → ничего не удаляем (deleted: false).
 * r2Key возвращается для удаления объекта ПОСЛЕ коммита.
 */
export async function deleteDayFile(
  documentId: number,
): Promise<{ deleted: boolean; r2Key: string | null; fileName: string | null }> {
  return withTransaction(async (client) => {
    const doc = await client.query<{ r2_key: string; file_name: string }>(
      `SELECT r2_key, file_name FROM documents WHERE id = $1 AND employee_id IS NULL FOR UPDATE`,
      [documentId],
    );
    if (doc.rows.length === 0) return { deleted: false, r2Key: null, fileName: null };

    const links = await client.query<{ entity_type: string; purpose: string | null }>(
      `SELECT entity_type, purpose FROM document_links WHERE document_id = $1`,
      [documentId],
    );
    const onlyDayLinks = links.rows.length > 0 && links.rows.every(
      link => link.entity_type === DAY_FILE_ENTITY_TYPE && link.purpose === DAY_FILE_PURPOSE,
    );
    if (!onlyDayLinks) return { deleted: false, r2Key: null, fileName: null };

    await client.query(`DELETE FROM document_links WHERE document_id = $1`, [documentId]);
    await client.query(`DELETE FROM documents WHERE id = $1`, [documentId]);
    return { deleted: true, r2Key: String(doc.rows[0].r2_key), fileName: String(doc.rows[0].file_name) };
  });
}
