/**
 * Откат выгрузки ведомостей по API (payroll_1c_payout_api_batches, миграция 379): возвращает ведомости, их строки и
 * состояние API к снимку «до». Откат возможен, только если после выгрузки эти ведомости больше не менялись: состояние
 * API (версия, действует / отменена, хеш) и ревизия документа — те же, что выгрузка оставила. Иначе — отказ целиком,
 * ничего не изменено, в ответе — что менялось после. Новая ведомость удаляется (её журнал — вместе с ней; след
 * остаётся в выгрузке), изменённая получает прежние шапку и строки (журнал — rollback со снимком до отката).
 * Принятая под API ведомость из файла (adopt) получает прежние ГУИД, origin и строки. После — сверка «ЗП к выплате»
 * (строка, снятая ведомостью из этой выгрузки, возвращается). Повторный откат — отказ. Только оператор
 * (scripts/rollback-payouts-api-batch.ts), не 1С.
 */
import type { PoolClient } from 'pg';

import { getPool } from '../../config/postgres.js';
import {
  insertSnapshotLines,
  payoutGuidLockKey,
  rowsOf,
  snapshotDoc,
  waitPayoutLocks,
  writeApiJournal,
} from './payroll-1c-payouts.api.store.js';
import { reconcileToPayLines, type IToPayChange } from './payroll-1c-payouts.to-pay.js';

interface IBatchChangeRow {
  guid: string;
  document_id: number | null;
  action: string;
  before: { state: Record<string, unknown> | null; document: Record<string, unknown> | null; lines: Array<Record<string, unknown>> };
  after: { version: number; state: 'active' | 'cancelled'; api_hash: string | null; revision: number | null };
}

export interface IPayoutRollbackResult {
  batchId: string;
  applied: boolean;
  documents: Array<{ guid: string; action: string; rollback: 'delete' | 'restore' | 'state_only' }>;
  /** Строки «ЗП к выплате», вернувшиеся (или снятые) после отката. */
  toPay: IToPayChange[];
}

export class PayoutRollbackError extends Error {
  constructor(message: string, readonly problems: string[] = []) {
    super(problems.length > 0 ? `${message}:\n  ${problems.join('\n  ')}` : message);
  }
}

const restoreState = async (client: PoolClient, guid: string, state: Record<string, unknown> | null): Promise<void> => {
  if (!state) {
    await client.query('DELETE FROM payroll_1c_payout_api_states WHERE doc_guid = $1::uuid', [guid]);
    return;
  }
  await client.query(
    `INSERT INTO payroll_1c_payout_api_states (doc_guid, version, state, api_hash, document_id, data_api_key_id, updated_at)
     VALUES ($1::uuid, $2, $3, $4, $5, $6::uuid, now())
     ON CONFLICT (doc_guid) DO UPDATE SET version = EXCLUDED.version, state = EXCLUDED.state, api_hash = EXCLUDED.api_hash,
       document_id = EXCLUDED.document_id, data_api_key_id = EXCLUDED.data_api_key_id, updated_at = now()`,
    [guid, state.version, state.state, state.api_hash, state.document_id, state.data_api_key_id ?? null],
  );
};

/** Проверка (apply = false) или откат выгрузки batchId; by — кто откатывает (журнал выгрузки). */
export const rollbackPayoutApiBatch = async (input: { batchId: string; by: string; apply: boolean }): Promise<IPayoutRollbackResult> => {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL fot.payout_writer = 'api'");
    const [batch] = await rowsOf<{ changes: IBatchChangeRow[]; rolled_back_at: string | null; body_sha256: string }>(
      client,
      'SELECT changes, rolled_back_at, body_sha256 FROM payroll_1c_payout_api_batches WHERE batch_id = $1::uuid FOR UPDATE',
      [input.batchId],
    );
    if (!batch) throw new PayoutRollbackError(`Выгрузки ${input.batchId} нет`);
    if (batch.rolled_back_at) throw new PayoutRollbackError(`Выгрузка ${input.batchId} уже откатана (${batch.rolled_back_at})`);
    const changes = batch.changes;
    await waitPayoutLocks(client, changes.map(change => payoutGuidLockKey(change.guid)));

    const problems: string[] = [];
    for (const change of changes) {
      const [state] = await rowsOf<{ version: string; state: string; api_hash: string | null }>(
        client, 'SELECT version, state, api_hash FROM payroll_1c_payout_api_states WHERE doc_guid = $1::uuid FOR UPDATE', [change.guid],
      );
      if (!state || Number(state.version) !== change.after.version || state.state !== change.after.state
        || state.api_hash !== change.after.api_hash) {
        problems.push(`${change.guid}: после выгрузки пришла другая версия или отмена`);
        continue;
      }
      if (change.after.revision !== null && change.document_id !== null) {
        const [doc] = await rowsOf<{ revision: number }>(
          client, 'SELECT revision FROM payroll_1c_payout_documents WHERE id = $1 FOR UPDATE', [change.document_id],
        );
        if (!doc || Number(doc.revision) !== change.after.revision) problems.push(`${change.guid}: ведомость изменили после выгрузки`);
      }
    }
    if (problems.length > 0) throw new PayoutRollbackError('Откат невозможен — ничего не изменено', problems);

    const documents: IPayoutRollbackResult['documents'] = [];
    for (const change of [...changes].reverse()) {
      if (change.after.revision === null || change.document_id === null) {
        // Только состояние API (тот же документ без изменений или отмена без документа).
        await restoreState(client, change.guid, change.before.state);
        documents.push({ guid: change.guid, action: change.action, rollback: 'state_only' });
        continue;
      }
      if (change.before.document === null) {
        await client.query('DELETE FROM payroll_1c_payout_documents WHERE id = $1', [change.document_id]);
        await restoreState(client, change.guid, change.before.state);
        documents.push({ guid: change.guid, action: change.action, rollback: 'delete' });
        continue;
      }
      const current = await snapshotDoc(client, change.document_id);
      const header = change.before.document;
      await client.query(
        `UPDATE payroll_1c_payout_documents SET doc_number = $2, zup2_number = $3, doc_date = $4::date, period_month = $5::date,
           payment_method = $6, salary_project = $7, organization_inn = $8, total_amount = $9::numeric, content_hash = $10,
           comment = $11, doc_guid = COALESCE($12::uuid, doc_guid), origin = COALESCE($13, origin),
           revision = revision + 1, updated_at = now(), updated_by = NULL
         WHERE id = $1`,
        [change.document_id, header.doc_number, header.zup2_number, header.doc_date, header.period_month, header.payment_method,
          header.salary_project, header.organization_inn, header.total_amount, header.content_hash, header.comment,
          header.doc_guid ?? null, header.origin ?? null],
      );
      await client.query('DELETE FROM payroll_1c_payout_lines WHERE document_id = $1', [change.document_id]);
      await insertSnapshotLines(client, change.document_id, change.before.lines);
      await writeApiJournal(client, {
        documentId: change.document_id, action: 'rollback', revisionBefore: Number(current?.header.revision ?? 0),
        contentHashBefore: current ? String(current.header.content_hash) : null, contentHashAfter: String(header.content_hash),
        previousHeader: current?.header ?? null, previousLines: current?.lines ?? [], bodySha256: batch.body_sha256,
        targets: [], amountsCents: new Map(), keyId: null, batchId: input.batchId,
      });
      await restoreState(client, change.guid, change.before.state);
      documents.push({ guid: change.guid, action: change.action, rollback: 'restore' });
    }
    const toPay = await reconcileToPayLines(client, { batchId: input.batchId, keyId: null, bodySha: batch.body_sha256 });
    await client.query(
      'UPDATE payroll_1c_payout_api_batches SET rolled_back_at = now(), rolled_back_by = $2 WHERE batch_id = $1::uuid',
      [input.batchId, input.by],
    );
    await client.query(input.apply ? 'COMMIT' : 'ROLLBACK');
    return { batchId: input.batchId, applied: input.apply, documents, toPay };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
};
