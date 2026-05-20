import { execute, query, queryOne } from '../config/postgres.js';
import { encryptionService } from './encryption.service.js';
import type { IMtsTaskApiResponse } from './mts-data.service.js';

// Локальное зеркало задач МТС. Контент (title/description/address/status/payload)
// шифруется AES-256-GCM. Структурные ключи (mts_task_id, subscriber_id, start_date,
// deadline, created_by) — plaintext, нужны для индексов/scope/сортировки.

export interface IMtsTaskRow {
  id: number;
  mtsTaskId: number | null;
  subscriberId: number | null;
  startDate: string;
  deadline: string | null;
  createdBy: string | null;
  title: string | null;
  description: string | null;
  address: string | null;
  status: string | null;
  createdAt: string;
  syncedAt: string;
}

interface ISaveCreatedTaskInput {
  mtsTaskId: number;
  subscriberId: number | null;
  startDate: string;
  deadline: string | null;
  title: string;
  description: string | null;
  address: string | null;
  status: string | null;
  payload: unknown;
  createdBy: string;
}

const enc = (v: string | null | undefined): string | null =>
  v === null || v === undefined || v === '' ? null : encryptionService.encrypt(v);
const dec = (v: string | null): string | null => encryptionService.decryptField(v);

const mapRow = (r: {
  id: number;
  mts_task_id: number | null;
  subscriber_id: number | null;
  start_date: string;
  deadline: string | null;
  created_by: string | null;
  title_enc: string | null;
  description_enc: string | null;
  address_enc: string | null;
  status_enc: string | null;
  created_at: string;
  synced_at: string;
}): IMtsTaskRow => ({
  id: r.id,
  mtsTaskId: r.mts_task_id,
  subscriberId: r.subscriber_id,
  startDate: r.start_date,
  deadline: r.deadline,
  createdBy: r.created_by,
  title: dec(r.title_enc),
  description: dec(r.description_enc),
  address: dec(r.address_enc),
  status: dec(r.status_enc),
  createdAt: r.created_at,
  syncedAt: r.synced_at,
});

export const mtsTasksService = {
  async saveCreatedTask(input: ISaveCreatedTaskInput): Promise<IMtsTaskRow> {
    const row = await queryOne<Parameters<typeof mapRow>[0]>(
      `INSERT INTO mts_tasks
         (mts_task_id, subscriber_id, start_date, deadline, created_by,
          title_enc, description_enc, address_enc, status_enc, payload_enc)
       VALUES ($1, $2, $3::timestamptz, $4::timestamptz, $5, $6, $7, $8, $9, $10)
       RETURNING id, mts_task_id, subscriber_id, start_date, deadline, created_by,
                 title_enc, description_enc, address_enc, status_enc, created_at, synced_at`,
      [
        input.mtsTaskId,
        input.subscriberId,
        input.startDate,
        input.deadline,
        input.createdBy,
        enc(input.title),
        enc(input.description),
        enc(input.address),
        enc(input.status),
        enc(JSON.stringify(input.payload ?? null)),
      ],
    );
    if (!row) throw new Error('Не удалось сохранить задачу МТС в БД');
    return mapRow(row);
  },

  /** Обновляет локальную копию задачи после refresh из МТС (status + payload). */
  async upsertSyncedTask(mtsTaskId: number, response: IMtsTaskApiResponse): Promise<void> {
    const status = typeof response.status === 'string' ? response.status : null;
    await execute(
      `UPDATE mts_tasks
          SET status_enc = $1, payload_enc = $2, synced_at = NOW()
        WHERE mts_task_id = $3`,
      [enc(status), enc(JSON.stringify(response)), mtsTaskId],
    );
  },

  /** Все локальные задачи (расшифрованные), сортировка по start_date DESC. */
  async listTasks(limit = 500): Promise<IMtsTaskRow[]> {
    const rows = await query<Parameters<typeof mapRow>[0]>(
      `SELECT id, mts_task_id, subscriber_id, start_date, deadline, created_by,
              title_enc, description_enc, address_enc, status_enc, created_at, synced_at
         FROM mts_tasks
        ORDER BY start_date DESC
        LIMIT $1`,
      [limit],
    );
    return rows.map(mapRow);
  },

  async getByMtsTaskId(mtsTaskId: number): Promise<IMtsTaskRow | null> {
    const row = await queryOne<Parameters<typeof mapRow>[0]>(
      `SELECT id, mts_task_id, subscriber_id, start_date, deadline, created_by,
              title_enc, description_enc, address_enc, status_enc, created_at, synced_at
         FROM mts_tasks
        WHERE mts_task_id = $1
        LIMIT 1`,
      [mtsTaskId],
    );
    return row ? mapRow(row) : null;
  },
};
