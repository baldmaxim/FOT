import type { PoolClient } from 'pg';

import { query, queryOne } from '../config/postgres.js';

// Файлы компенсации аренды сотрудника (миграция 380): строка — объект R2; автор — в аудите. Файлы — у сотрудника, а не
// у записи компенсации: не теряются при паузе и возобновлении. Образец — файлы шаблонов графиков (376).

/** Предел файлов у сотрудника: проверяется под замком сотрудника (lockPayrollEmployee). */
export const COMPENSATION_FILES_MAX = 20;

export interface ICompensationFile {
  id: number;
  file_name: string;
  file_size: number;
  mime_type: string;
  created_at: string;
}

export interface ICompensationFileObject {
  id: number;
  file_name: string;
  mime_type: string;
  r2_key: string;
}

interface ICompensationFileRow {
  id: number | string;
  file_name: string;
  file_size: number | string;
  mime_type: string;
  created_at: string | Date;
}

const mapFile = (row: ICompensationFileRow): ICompensationFile => ({
  id: Number(row.id),
  file_name: String(row.file_name),
  file_size: Number(row.file_size),
  mime_type: String(row.mime_type),
  created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
});

const FILE_COLUMNS = 'id, file_name, file_size, mime_type, created_at';

/** Есть ли у сотрудника компенсация аренды (хоть одна запись вида apartment): файлы — только у таких. */
export async function hasCompensation(employeeId: number, client?: PoolClient): Promise<boolean> {
  const sql = `SELECT EXISTS (
                 SELECT 1 FROM employee_dormitory_stays WHERE employee_id = $1 AND kind = 'apartment'
               ) AS found`;
  if (client) return (await client.query<{ found: boolean }>(sql, [employeeId])).rows[0]?.found === true;
  return (await queryOne<{ found: boolean }>(sql, [employeeId]))?.found === true;
}

export async function listCompensationFiles(employeeId: number): Promise<ICompensationFile[]> {
  const rows = await query<ICompensationFileRow>(
    `SELECT ${FILE_COLUMNS}
       FROM dormitory_compensation_files
      WHERE employee_id = $1
      ORDER BY created_at, id`,
    [employeeId],
  );
  return rows.map(mapFile);
}

/** Число файлов по сотрудникам (нет файлов — нет в карте). */
export async function countCompensationFiles(employeeIds: readonly number[]): Promise<Map<number, number>> {
  if (employeeIds.length === 0) return new Map();
  const rows = await query<{ employee_id: number | string; total: number | string }>(
    `SELECT employee_id, count(*)::int AS total
       FROM dormitory_compensation_files
      WHERE employee_id = ANY($1::int[])
      GROUP BY employee_id`,
    [[...new Set(employeeIds)]],
  );
  return new Map(rows.map(row => [Number(row.employee_id), Number(row.total)]));
}

/** Файл именно этого сотрудника; чужой — null. */
export async function getCompensationFileObject(employeeId: number, fileId: number): Promise<ICompensationFileObject | null> {
  const row = await queryOne<{ id: number | string; file_name: string; mime_type: string; r2_key: string }>(
    `SELECT id, file_name, mime_type, r2_key
       FROM dormitory_compensation_files
      WHERE employee_id = $1 AND id = $2`,
    [employeeId, fileId],
  );
  if (!row) return null;
  return { id: Number(row.id), file_name: String(row.file_name), mime_type: String(row.mime_type), r2_key: String(row.r2_key) };
}

export async function countEmployeeCompensationFiles(client: PoolClient, employeeId: number): Promise<number> {
  const result = await client.query<{ total: number }>(
    'SELECT count(*)::int AS total FROM dormitory_compensation_files WHERE employee_id = $1',
    [employeeId],
  );
  return Number(result.rows[0]?.total ?? 0);
}

export async function insertCompensationFile(
  client: PoolClient,
  params: { employeeId: number; r2Key: string; fileName: string; fileSize: number; mimeType: string },
): Promise<ICompensationFile> {
  const result = await client.query<ICompensationFileRow>(
    `INSERT INTO dormitory_compensation_files (employee_id, r2_key, file_name, file_size, mime_type)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${FILE_COLUMNS}`,
    [params.employeeId, params.r2Key, params.fileName, params.fileSize, params.mimeType],
  );
  const row = result.rows[0];
  if (!row) throw new Error('dormitory_compensation_files: строка не вставлена');
  return mapFile(row);
}

/** Удаляет файл этого сотрудника; чужой или уже удалённый — null. r2_key — для удаления объекта после коммита. */
export async function deleteCompensationFile(
  client: PoolClient,
  employeeId: number,
  fileId: number,
): Promise<{ r2Key: string; fileName: string } | null> {
  const result = await client.query<{ r2_key: string; file_name: string }>(
    `DELETE FROM dormitory_compensation_files
      WHERE employee_id = $1 AND id = $2
      RETURNING r2_key, file_name`,
    [employeeId, fileId],
  );
  const row = result.rows[0];
  return row ? { r2Key: String(row.r2_key), fileName: String(row.file_name) } : null;
}
