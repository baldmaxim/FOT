import type { PoolClient } from 'pg';
import { query, queryOne } from '../config/postgres.js';

// Файлы шаблонов графиков работы (миграция 376). Строка — объект R2; автор — в аудите.

/** Предел файлов у одного графика: проверяется под блокировкой строки графика. */
export const SCHEDULE_FILES_MAX = 20;

export interface IScheduleFile {
  id: number;
  file_name: string;
  file_size: number;
  mime_type: string;
  created_at: string;
}

export interface IScheduleFileObject {
  id: number;
  file_name: string;
  mime_type: string;
  r2_key: string;
}

/** Состояние графика для файлов: нет / в архиве / действующий. */
export type ScheduleFilesTarget = 'missing' | 'archived' | 'active';

interface IScheduleRow {
  archived_at: string | Date | null;
}

const toTarget = (row: IScheduleRow | null | undefined): ScheduleFilesTarget => {
  if (!row) return 'missing';
  return row.archived_at ? 'archived' : 'active';
};

interface IScheduleFileRow {
  id: number | string;
  file_name: string;
  file_size: number | string;
  mime_type: string;
  created_at: string | Date;
}

const mapFile = (row: IScheduleFileRow): IScheduleFile => ({
  id: Number(row.id),
  file_name: String(row.file_name),
  file_size: Number(row.file_size),
  mime_type: String(row.mime_type),
  created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
});

const FILE_COLUMNS = 'id, file_name, file_size, mime_type, created_at';

/** Без блокировки — для чтения и предпроверки до загрузки в R2. */
export async function getScheduleFilesTarget(scheduleId: string): Promise<ScheduleFilesTarget> {
  const row = await queryOne<IScheduleRow>('SELECT archived_at FROM work_schedules WHERE id = $1', [scheduleId]);
  return toTarget(row);
}

/**
 * Блокирует строку графика до конца транзакции — так же, как архивация (archiveScheduleTemplate):
 * загрузка, удаление и архивация одного графика идут по очереди, предел файлов не обгоняется.
 */
export async function lockScheduleForFiles(client: PoolClient, scheduleId: string): Promise<ScheduleFilesTarget> {
  const result = await client.query<IScheduleRow>(
    'SELECT archived_at FROM work_schedules WHERE id = $1 FOR UPDATE',
    [scheduleId],
  );
  return toTarget(result.rows[0]);
}

export async function listScheduleFiles(scheduleId: string): Promise<IScheduleFile[]> {
  const rows = await query<IScheduleFileRow>(
    `SELECT ${FILE_COLUMNS}
       FROM work_schedule_files
      WHERE schedule_id = $1
      ORDER BY created_at, id`,
    [scheduleId],
  );
  return rows.map(mapFile);
}

/** Файл именно этого графика; чужой — null. */
export async function getScheduleFileObject(scheduleId: string, fileId: number): Promise<IScheduleFileObject | null> {
  const row = await queryOne<{ id: number | string; file_name: string; mime_type: string; r2_key: string }>(
    `SELECT id, file_name, mime_type, r2_key
       FROM work_schedule_files
      WHERE schedule_id = $1 AND id = $2`,
    [scheduleId, fileId],
  );
  if (!row) return null;
  return { id: Number(row.id), file_name: String(row.file_name), mime_type: String(row.mime_type), r2_key: String(row.r2_key) };
}

export async function countScheduleFiles(client: PoolClient, scheduleId: string): Promise<number> {
  const result = await client.query<{ total: number }>(
    'SELECT count(*)::int AS total FROM work_schedule_files WHERE schedule_id = $1',
    [scheduleId],
  );
  return Number(result.rows[0]?.total ?? 0);
}

export async function insertScheduleFile(
  client: PoolClient,
  params: { scheduleId: string; r2Key: string; fileName: string; fileSize: number; mimeType: string },
): Promise<IScheduleFile> {
  const result = await client.query<IScheduleFileRow>(
    `INSERT INTO work_schedule_files (schedule_id, r2_key, file_name, file_size, mime_type)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${FILE_COLUMNS}`,
    [params.scheduleId, params.r2Key, params.fileName, params.fileSize, params.mimeType],
  );
  const row = result.rows[0];
  if (!row) throw new Error('work_schedule_files: строка не вставлена');
  return mapFile(row);
}

/** Удаляет файл этого графика; чужой или уже удалённый — null. r2_key — для удаления объекта после коммита. */
export async function deleteScheduleFile(
  client: PoolClient,
  scheduleId: string,
  fileId: number,
): Promise<{ r2Key: string; fileName: string } | null> {
  const result = await client.query<{ r2_key: string; file_name: string }>(
    `DELETE FROM work_schedule_files
      WHERE schedule_id = $1 AND id = $2
      RETURNING r2_key, file_name`,
    [scheduleId, fileId],
  );
  const row = result.rows[0];
  return row ? { r2Key: String(row.r2_key), fileName: String(row.file_name) } : null;
}
