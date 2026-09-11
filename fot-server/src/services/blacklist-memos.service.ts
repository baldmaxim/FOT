import type { PoolClient } from 'pg';
import { query, queryOne } from '../config/postgres.js';

/**
 * Служебные записки к записям чёрного списка (миграция 274).
 *
 * Идемпотентность держится на sha256 содержимого: одна активная записка на
 * (запись, файл). Загрузка и удаление берут ОДИН И ТОТ ЖЕ advisory-лок
 * `entryId + sha256` и перечитывают строку только внутри него. Незаблокированной
 * проверки «уже есть» нет намеренно: иначе параллельное удаление могло бы скрыть
 * строку сразу после проверки, а загрузка ответила бы created=false при
 * отсутствии активной записки.
 *
 * Объекты R2 этот модуль не удаляет никогда — ни при удалении записки, ни при
 * сбоях: потерять доказательство хуже, чем хранить лишний файл.
 */

export interface IBlacklistMemo {
  id: string;
  blacklist_id: string;
  file_name: string;
  file_size: number;
  mime_type: string;
  sha256: string;
  r2_key: string;
  uploaded_by_name: string;
  created_at: string;
}

const MEMO_COLUMNS = `id, blacklist_id, file_name, file_size, mime_type, sha256, r2_key,
  uploaded_by_name, created_at::text AS created_at`;

const mapMemo = (row: IBlacklistMemo): IBlacklistMemo => ({
  ...row,
  file_size: Number(row.file_size),
  sha256: String(row.sha256).trim(),
});

/** Существует ли запись ЧС (активная или снятая — к истории тоже можно приложить документ). */
export async function blacklistEntryExists(entryId: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    'SELECT id FROM public.person_blacklist WHERE id = $1::uuid',
    [entryId],
  );
  return !!row;
}

/** Активные записки записи, новые сверху. */
export async function listMemos(entryId: string): Promise<IBlacklistMemo[]> {
  const rows = await query<IBlacklistMemo>(
    `SELECT ${MEMO_COLUMNS}
       FROM public.person_blacklist_memos
      WHERE blacklist_id = $1::uuid AND deleted_at IS NULL
      ORDER BY created_at DESC`,
    [entryId],
  );
  return rows.map(mapMemo);
}

/** Единый лок для загрузки и удаления одного файла одной записи. */
export async function lockMemoIn(client: PoolClient, entryId: string, sha256: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`blacklist:memo:${entryId}:${sha256}`]);
}

/** Только внутри транзакции и только после lockMemoIn. */
export async function findActiveMemoIn(
  client: PoolClient,
  entryId: string,
  sha256: string,
): Promise<IBlacklistMemo | null> {
  const res = await client.query<IBlacklistMemo>(
    `SELECT ${MEMO_COLUMNS}
       FROM public.person_blacklist_memos
      WHERE blacklist_id = $1::uuid AND sha256 = $2 AND deleted_at IS NULL
      LIMIT 1`,
    [entryId, sha256],
  );
  return res.rows[0] ? mapMemo(res.rows[0]) : null;
}

export interface IInsertMemoParams {
  entryId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  sha256: string;
  r2Key: string;
  uploadedBy: string | null;
  uploadedByName: string;
}

/**
 * Вставка записки. ON CONFLICT по частичному unique-индексу — страховка на случай
 * гонки вне лока: возвращаем существующую строку как created=false, а не 500.
 */
export async function insertMemoIn(
  client: PoolClient,
  params: IInsertMemoParams,
): Promise<{ memo: IBlacklistMemo; created: boolean }> {
  const res = await client.query<IBlacklistMemo>(
    `INSERT INTO public.person_blacklist_memos
       (blacklist_id, file_name, file_size, mime_type, sha256, r2_key, uploaded_by, uploaded_by_name)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::uuid, $8)
     ON CONFLICT (blacklist_id, sha256) WHERE deleted_at IS NULL DO NOTHING
     RETURNING ${MEMO_COLUMNS}`,
    [
      params.entryId, params.fileName, params.fileSize, params.mimeType,
      params.sha256, params.r2Key, params.uploadedBy, params.uploadedByName,
    ],
  );
  if (res.rows[0]) return { memo: mapMemo(res.rows[0]), created: true };

  const existing = await findActiveMemoIn(client, params.entryId, params.sha256);
  if (!existing) throw new Error('Конфликт вставки записки без существующей строки');
  return { memo: existing, created: false };
}

/**
 * Приложить записку идемпотентно: лок → перечитать → вставить. Вызывать внутри
 * транзакции; объект в R2 к этому моменту уже загружен.
 */
export async function attachMemoIn(
  client: PoolClient,
  params: IInsertMemoParams,
): Promise<{ memo: IBlacklistMemo; created: boolean }> {
  await lockMemoIn(client, params.entryId, params.sha256);
  const existing = await findActiveMemoIn(client, params.entryId, params.sha256);
  if (existing) return { memo: existing, created: false };
  return insertMemoIn(client, params);
}

export type SoftDeleteMemoResult =
  | { status: 'not_found' }
  | { status: 'deleted'; memo: IBlacklistMemo }
  | { status: 'already_deleted'; memo: IBlacklistMemo };

/**
 * Мягкое удаление. Сначала узнаём sha256 записки (с проверкой, что она принадлежит
 * этой записи), берём тот же лок, что и загрузка, и перечитываем строку FOR UPDATE —
 * решение принимается только по состоянию внутри лока.
 */
export async function softDeleteMemoIn(
  client: PoolClient,
  entryId: string,
  memoId: string,
  actor: { id: string | null; name: string },
): Promise<SoftDeleteMemoResult> {
  const probe = await client.query<{ sha256: string }>(
    `SELECT sha256 FROM public.person_blacklist_memos
      WHERE id = $1::uuid AND blacklist_id = $2::uuid`,
    [memoId, entryId],
  );
  if (!probe.rows[0]) return { status: 'not_found' };

  await lockMemoIn(client, entryId, String(probe.rows[0].sha256).trim());

  const locked = await client.query<IBlacklistMemo & { deleted_at: string | null }>(
    `SELECT ${MEMO_COLUMNS}, deleted_at::text AS deleted_at
       FROM public.person_blacklist_memos
      WHERE id = $1::uuid AND blacklist_id = $2::uuid
      FOR UPDATE`,
    [memoId, entryId],
  );
  const row = locked.rows[0];
  if (!row) return { status: 'not_found' };
  if (row.deleted_at) return { status: 'already_deleted', memo: mapMemo(row) };

  await client.query(
    `UPDATE public.person_blacklist_memos
        SET deleted_at = now(), deleted_by = $2::uuid, deleted_by_name = $3
      WHERE id = $1::uuid AND deleted_at IS NULL`,
    [memoId, actor.id, actor.name],
  );
  return { status: 'deleted', memo: mapMemo(row) };
}
