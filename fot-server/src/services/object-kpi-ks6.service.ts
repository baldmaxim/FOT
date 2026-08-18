import type { PoolClient } from 'pg';

import { query } from '../config/postgres.js';
import { failNotFound, failStaleVersion, failWith } from './object-kpi-errors.js';
import { recordObjectKpiHistory, type ObjectKpiActor } from './object-kpi-history.service.js';
import { assertDraft, lockContract, rethrowUnique, type EntryStatus } from './object-kpi.service.js';

/**
 * Реестр КС-6 (журнал учёта выполненных работ).
 *
 * СЕЙЧАС ИНТЕРФЕЙСОМ НЕ ИСПОЛЬЗУЕТСЯ. Колонка «КС-6» в отчёте — накопительный итог
 * подписанных КС-2, то есть производная от актов, а не отдельный ввод; вкладка ручного
 * ввода убрана, чтобы одну и ту же величину не заводили дважды. Таблица, эндпоинты и этот
 * сервис оставлены рабочими: если журнал КС-6 понадобится вести отдельно от актов,
 * вернуть вкладку дешевле, чем восстанавливать удалённое.
 *
 * КС-6 — СПРАВОЧНАЯ величина: в стоимость договора, остаток, план месяца, факт и процент
 * выполнения она не входит (см. 243_object_ks6_entries.sql). Отсюда единственное осознанное
 * отличие от КС-2: `requireReasonIfMonthFixed` здесь НЕ вызывается — зафиксированный план
 * записью КС-6 не сдвинуть, требовать основание не за что.
 *
 * Отдельный файл, а не блок в object-kpi.service.ts: тот уже за 700 строк при лимите 500.
 * Хелперы (lockContract, assertDraft, rethrowUnique) импортируются оттуда, а не копируются:
 * разъехавшиеся копии lockContract дают разный порядок блокировок и дедлок.
 */

export interface ObjectKs6Row {
  id: string;
  contract_id: string;
  skud_object_id: string;
  amount: string;
  doc_number: string;
  customer_signed_date: string;
  period_month: string;
  status: EntryStatus;
  notes: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

const KS6_COLUMNS = `
  id, contract_id, skud_object_id, amount, doc_number,
  to_char(customer_signed_date, 'YYYY-MM-DD') AS customer_signed_date,
  to_char(period_month, 'YYYY-MM-DD')         AS period_month,
  status, notes, version, created_at, updated_at`;

const DUPLICATE_MESSAGE = 'Запись с таким номером КС-6 уже есть в договоре';

export interface Ks6Input {
  /** Только положительная: знака у КС-6 нет, ошибочная запись аннулируется. */
  amount: number | string;
  doc_number: string;
  customer_signed_date: string;
  notes?: string | null;
}

export async function listKs6Entries(contractId: string): Promise<ObjectKs6Row[]> {
  return query<ObjectKs6Row>(
    `SELECT ${KS6_COLUMNS} FROM object_ks6_entries
      WHERE contract_id = $1
      ORDER BY customer_signed_date, created_at`,
    [contractId],
  );
}

const positiveAmount = (amount: number | string): number => {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) {
    failWith({ http: 400, code: 'bad_amount', message: 'Сумма КС-6 должна быть больше нуля' });
  }
  return value;
};

export async function createKs6Entry(
  client: PoolClient,
  actor: ObjectKpiActor,
  contractId: string,
  input: Ks6Input,
): Promise<ObjectKs6Row> {
  const contract = await lockContract(client, contractId);

  let row: ObjectKs6Row;
  try {
    const result = await client.query<ObjectKs6Row>(
      `INSERT INTO object_ks6_entries (
         contract_id, skud_object_id, amount, doc_number,
         customer_signed_date, status, notes, created_by, updated_by
       ) VALUES ($1,$2,$3,$4,$5,'draft',$6,$7,$7)
       RETURNING ${KS6_COLUMNS}`,
      [
        contractId,
        contract.skud_object_id,
        positiveAmount(input.amount),
        input.doc_number,
        input.customer_signed_date,
        input.notes ?? null,
        actor.userId,
      ],
    );
    row = result.rows[0];
  } catch (error) {
    return rethrowUnique(error, DUPLICATE_MESSAGE);
  }

  await recordObjectKpiHistory(client, {
    skudObjectId: contract.skud_object_id,
    entityKind: 'ks6',
    entityId: row.id,
    action: 'create',
    after: { ...row },
    actor,
  });
  return row;
}

async function lockKs6Entry(client: PoolClient, entryId: string): Promise<ObjectKs6Row> {
  const result = await client.query<ObjectKs6Row>(
    `SELECT ${KS6_COLUMNS} FROM object_ks6_entries WHERE id = $1 FOR UPDATE`,
    [entryId],
  );
  const row = result.rows[0];
  if (!row) failNotFound('Запись КС-6');
  return row;
}

export async function updateKs6Entry(
  client: PoolClient,
  actor: ObjectKpiActor,
  entryId: string,
  expectedVersion: number,
  patch: Partial<Ks6Input>,
): Promise<ObjectKs6Row> {
  const before = await lockKs6Entry(client, entryId);
  assertDraft(before.status, 'Запись КС-6');

  const values: Array<[string, unknown]> = [];
  if (patch.doc_number !== undefined) values.push(['doc_number', patch.doc_number]);
  if (patch.customer_signed_date !== undefined) {
    values.push(['customer_signed_date', patch.customer_signed_date]);
  }
  if (patch.notes !== undefined) values.push(['notes', patch.notes]);
  if (patch.amount !== undefined) values.push(['amount', positiveAmount(patch.amount)]);
  if (values.length === 0) return before;

  const setSql = values.map(([field], i) => `${field} = $${i + 4}`).join(', ');
  let after: ObjectKs6Row | undefined;
  try {
    const result = await client.query<ObjectKs6Row>(
      `UPDATE object_ks6_entries
          SET ${setSql}, version = version + 1, updated_by = $3, updated_at = now()
        WHERE id = $1 AND version = $2
        RETURNING ${KS6_COLUMNS}`,
      [entryId, expectedVersion, actor.userId, ...values.map(([, value]) => value)],
    );
    after = result.rows[0];
  } catch (error) {
    return rethrowUnique(error, DUPLICATE_MESSAGE);
  }
  if (!after) failStaleVersion();

  await recordObjectKpiHistory(client, {
    skudObjectId: before.skud_object_id,
    entityKind: 'ks6',
    entityId: entryId,
    action: 'update',
    before: { ...before },
    after: { ...after },
    actor,
  });
  return after;
}

export async function setKs6Status(
  client: PoolClient,
  actor: ObjectKpiActor,
  entryId: string,
  nextStatus: 'signed' | 'cancelled',
  expectedVersion: number,
  reason?: string | null,
): Promise<ObjectKs6Row> {
  const before = await lockKs6Entry(client, entryId);

  if (before.status === nextStatus) return before;
  if (nextStatus === 'signed' && before.status !== 'draft') {
    failWith({
      http: 409,
      code: 'bad_transition',
      message: 'Аннулированную запись КС-6 подписать нельзя',
    });
  }

  // requireReasonIfMonthFixed НЕ вызывается намеренно: КС-6 не входит ни в план, ни в факт,
  // и зафиксированный месяц этой записью не меняется. Симметрия с КС-2 здесь была бы
  // требованием основания на ровном месте.
  const result = await client.query<ObjectKs6Row>(
    `UPDATE object_ks6_entries
        SET status = $4, version = version + 1, updated_by = $3, updated_at = now()
      WHERE id = $1 AND version = $2
      RETURNING ${KS6_COLUMNS}`,
    [entryId, expectedVersion, actor.userId, nextStatus],
  );
  const after = result.rows[0];
  if (!after) failStaleVersion();

  await recordObjectKpiHistory(client, {
    skudObjectId: before.skud_object_id,
    entityKind: 'ks6',
    entityId: entryId,
    action: 'update',
    before: { ...before },
    after: { ...after },
    changedFields: ['status'],
    reason,
    actor,
  });
  return after;
}

export async function deleteKs6Entry(
  client: PoolClient,
  actor: ObjectKpiActor,
  entryId: string,
  expectedVersion: number,
): Promise<void> {
  const before = await lockKs6Entry(client, entryId);
  assertDraft(before.status, 'Запись КС-6');

  const result = await client.query(
    'DELETE FROM object_ks6_entries WHERE id = $1 AND version = $2',
    [entryId, expectedVersion],
  );
  if ((result.rowCount ?? 0) === 0) failStaleVersion();

  await recordObjectKpiHistory(client, {
    skudObjectId: before.skud_object_id,
    entityKind: 'ks6',
    entityId: entryId,
    action: 'delete',
    before: { ...before },
    actor,
  });
}
