import type { PoolClient } from 'pg';

import { query, queryOne } from '../config/postgres.js';
import { moscowTodayIso } from '../utils/date.utils.js';
import { failNotFound, failStaleVersion, failWith } from './object-kpi-errors.js';
import {
  recordObjectKpiHistory,
  requireReasonIfMonthFixed,
  requireReasonIfObjectHasFixedMonths,
  type ObjectKpiActor,
} from './object-kpi-history.service.js';

/**
 * Денежный контур KPI: договоры, допсоглашения, акты КС-2.
 *
 * Все пишущие функции принимают `client: PoolClient` первым аргументом и обязаны
 * вызываться из `withTransaction` контроллера. Мимо client — значит мимо транзакции:
 * блокировка договора, проверка суммы, сама запись и строка истории должны либо
 * состояться целиком, либо не состояться вовсе.
 *
 * Закрепления и глобальные роли живут в object-kpi-assignments.service.ts — здесь
 * только деньги, иначе файл перевалит за лимит в 500 строк.
 */

// ─── Общие типы ─────────────────────────────────────────────────────────────

export type EntryStatus = 'draft' | 'signed' | 'cancelled';

export interface ObjectContractRow {
  id: string;
  skud_object_id: string;
  contract_number: string | null;
  contract_date: string | null;
  customer_name: string | null;
  base_amount: string;
  planned_zos_date: string | null;
  actual_zos_date: string | null;
  plan_start_month: string | null;
  planned_headcount: number | null;
  is_active: boolean;
  notes: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface ObjectAddendumRow {
  id: string;
  contract_id: string;
  addendum_number: string;
  addendum_date: string;
  effective_date: string;
  amount_delta: string;
  status: EntryStatus;
  notes: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface ObjectKs2Row {
  id: string;
  contract_id: string;
  skud_object_id: string;
  entry_kind: 'act' | 'reduction';
  amount: string;
  act_number: string;
  customer_signed_date: string;
  period_month: string;
  status: EntryStatus;
  /** manual — заведено руками; fact_adjustment — корректировка факта, причина в notes. */
  source: 'manual' | 'fact_adjustment';
  notes: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

const CONTRACT_COLUMNS = `
  id, skud_object_id, contract_number, to_char(contract_date, 'YYYY-MM-DD') AS contract_date,
  customer_name, base_amount,
  to_char(planned_zos_date, 'YYYY-MM-DD') AS planned_zos_date,
  to_char(actual_zos_date, 'YYYY-MM-DD')  AS actual_zos_date,
  to_char(plan_start_month, 'YYYY-MM-DD') AS plan_start_month,
  planned_headcount, is_active, notes, version, created_at, updated_at`;

const ADDENDUM_COLUMNS = `
  id, contract_id, addendum_number,
  to_char(addendum_date, 'YYYY-MM-DD')  AS addendum_date,
  to_char(effective_date, 'YYYY-MM-DD') AS effective_date,
  amount_delta, status, notes, version, created_at, updated_at`;

const KS2_COLUMNS = `
  id, contract_id, skud_object_id, entry_kind, amount, act_number,
  to_char(customer_signed_date, 'YYYY-MM-DD') AS customer_signed_date,
  to_char(period_month, 'YYYY-MM-DD')         AS period_month,
  status, source, notes, version, created_at, updated_at`;

/** Уникальные индексы отдаются пользователю понятным текстом, а не «duplicate key». */
const UNIQUE_VIOLATION = '23505';

export const rethrowUnique = (error: unknown, message: string): never => {
  if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
    failWith({ http: 409, code: 'duplicate', message });
  }
  throw error;
};

// ─── Договоры ───────────────────────────────────────────────────────────────

export async function getContractByObject(objectId: string): Promise<ObjectContractRow | null> {
  return queryOne<ObjectContractRow>(
    `SELECT ${CONTRACT_COLUMNS} FROM object_contracts WHERE skud_object_id = $1`,
    [objectId],
  );
}

export async function getContractById(contractId: string): Promise<ObjectContractRow | null> {
  return queryOne<ObjectContractRow>(
    `SELECT ${CONTRACT_COLUMNS} FROM object_contracts WHERE id = $1`,
    [contractId],
  );
}

/**
 * Блокировка договора на время транзакции.
 *
 * Без FOR UPDATE два параллельных подписания ДС проверят «сумма не уйдёт в минус»
 * каждый по отдельности и вместе уведут стоимость договора ниже нуля.
 */
export async function lockContract(
  client: PoolClient,
  contractId: string,
): Promise<ObjectContractRow> {
  const result = await client.query<ObjectContractRow>(
    `SELECT ${CONTRACT_COLUMNS} FROM object_contracts WHERE id = $1 FOR UPDATE`,
    [contractId],
  );
  const row = result.rows[0];
  if (!row) failNotFound('Договор');
  return row;
}

export interface ContractInput {
  contract_number?: string | null;
  contract_date?: string | null;
  customer_name?: string | null;
  base_amount: number | string;
  planned_zos_date?: string | null;
  actual_zos_date?: string | null;
  plan_start_month?: string | null;
  planned_headcount?: number | null;
  notes?: string | null;
}

export async function createContract(
  client: PoolClient,
  actor: ObjectKpiActor,
  objectId: string,
  input: ContractInput,
): Promise<ObjectContractRow> {
  const objectExists = await client.query('SELECT 1 FROM skud_objects WHERE id = $1', [objectId]);
  if ((objectExists.rowCount ?? 0) === 0) failNotFound('Объект');

  let row: ObjectContractRow;
  try {
    const result = await client.query<ObjectContractRow>(
      `INSERT INTO object_contracts (
         skud_object_id, contract_number, contract_date, customer_name, base_amount,
         planned_zos_date, actual_zos_date, plan_start_month, planned_headcount, notes,
         created_by, updated_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
       RETURNING ${CONTRACT_COLUMNS}`,
      [
        objectId,
        input.contract_number ?? null,
        input.contract_date ?? null,
        input.customer_name ?? null,
        input.base_amount,
        input.planned_zos_date ?? null,
        input.actual_zos_date ?? null,
        input.plan_start_month ?? null,
        input.planned_headcount ?? null,
        input.notes ?? null,
        actor.userId,
      ],
    );
    row = result.rows[0];
  } catch (error) {
    return rethrowUnique(error, 'У объекта уже есть договор — правьте существующий');
  }

  await recordObjectKpiHistory(client, {
    skudObjectId: objectId,
    entityKind: 'contract',
    entityId: row.id,
    action: 'create',
    after: { ...row },
    actor,
  });
  return row;
}

/** Поля договора, которые разрешено править. version и служебные — не отсюда. */
const CONTRACT_PATCHABLE = [
  'contract_number',
  'contract_date',
  'customer_name',
  'base_amount',
  'planned_zos_date',
  'actual_zos_date',
  'plan_start_month',
  'planned_headcount',
  'is_active',
  'notes',
] as const;

export type ContractPatch = Partial<Record<(typeof CONTRACT_PATCHABLE)[number], unknown>>;

export async function updateContract(
  client: PoolClient,
  actor: ObjectKpiActor,
  contractId: string,
  expectedVersion: number,
  patch: ContractPatch,
  reason?: string | null,
): Promise<ObjectContractRow> {
  const before = await lockContract(client, contractId);

  // Правка договора бьёт по всем месяцам сразу, поэтому основание требуется,
  // как только у объекта есть хоть один закрытый месяц.
  await requireReasonIfObjectHasFixedMonths(client, before.skud_object_id, reason);

  if (patch.base_amount !== undefined) {
    await assertContractTotalNonNegative(client, contractId, Number(patch.base_amount));
  }

  const entries = CONTRACT_PATCHABLE.filter((f) => patch[f] !== undefined).map((f) => [f, patch[f]] as const);
  if (entries.length === 0) return before;

  const setSql = entries.map(([field], i) => `${field} = $${i + 4}`).join(', ');
  const result = await client.query<ObjectContractRow>(
    `UPDATE object_contracts
        SET ${setSql}, version = version + 1, updated_by = $3, updated_at = now()
      WHERE id = $1 AND version = $2
      RETURNING ${CONTRACT_COLUMNS}`,
    [contractId, expectedVersion, actor.userId, ...entries.map(([, value]) => value)],
  );

  const after = result.rows[0];
  if (!after) failStaleVersion();

  await recordObjectKpiHistory(client, {
    skudObjectId: before.skud_object_id,
    entityKind: 'contract',
    entityId: contractId,
    action: 'update',
    before: { ...before },
    after: { ...after },
    reason,
    actor,
  });
  return after;
}

/**
 * Стоимость договора не может уйти в минус: сумма подписанных ДС считается в той же
 * транзакции, под уже взятой блокировкой договора.
 */
async function assertContractTotalNonNegative(
  client: PoolClient,
  contractId: string,
  baseAmount: number,
  extraDelta = 0,
): Promise<void> {
  const result = await client.query<{ total: string }>(
    `SELECT COALESCE(SUM(amount_delta), 0)::numeric AS total
       FROM object_contract_addenda
      WHERE contract_id = $1 AND status = 'signed'`,
    [contractId],
  );
  const total = baseAmount + Number(result.rows[0].total) + extraDelta;
  if (total < 0) {
    failWith({
      http: 409,
      code: 'negative_contract_total',
      message: 'Стоимость договора с учётом допсоглашений стала бы отрицательной',
    });
  }
}

// ─── Допсоглашения ──────────────────────────────────────────────────────────

export async function listAddenda(contractId: string): Promise<ObjectAddendumRow[]> {
  return query<ObjectAddendumRow>(
    `SELECT ${ADDENDUM_COLUMNS} FROM object_contract_addenda
      WHERE contract_id = $1
      ORDER BY effective_date, created_at`,
    [contractId],
  );
}

export interface AddendumInput {
  addendum_number: string;
  addendum_date: string;
  effective_date: string;
  amount_delta: number | string;
  notes?: string | null;
}

/**
 * Месяц, на план которого влияет допсоглашение: ДС, действующий с 1-го числа, входит
 * в план ЭТОГО месяца, с 20-го — следующего. Та же арифметика, что в SQL отчёта
 * (`effective_date - 1 day` → начало месяца), поэтому проверка «закрыт ли месяц»
 * и сам расчёт не разъезжаются.
 */
function addendumImpactMonth(effectiveDate: string): string {
  const [year, month, day] = effectiveDate.split('-').map(Number);
  const prevDay = new Date(Date.UTC(year, month - 1, day - 1));
  return `${prevDay.getUTCFullYear()}-${String(prevDay.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

export async function createAddendum(
  client: PoolClient,
  actor: ObjectKpiActor,
  contractId: string,
  input: AddendumInput,
): Promise<ObjectAddendumRow> {
  const contract = await lockContract(client, contractId);

  // Создаётся всегда как draft: в расчёт идут только signed (п. 3.2), а подписание —
  // отдельное действие с проверкой суммы.
  let row: ObjectAddendumRow;
  try {
    const result = await client.query<ObjectAddendumRow>(
      `INSERT INTO object_contract_addenda (
         contract_id, addendum_number, addendum_date, effective_date, amount_delta,
         status, notes, created_by, updated_by
       ) VALUES ($1,$2,$3,$4,$5,'draft',$6,$7,$7)
       RETURNING ${ADDENDUM_COLUMNS}`,
      [
        contractId,
        input.addendum_number,
        input.addendum_date,
        input.effective_date,
        input.amount_delta,
        input.notes ?? null,
        actor.userId,
      ],
    );
    row = result.rows[0];
  } catch (error) {
    return rethrowUnique(error, 'Допсоглашение с таким номером уже есть в договоре');
  }

  await recordObjectKpiHistory(client, {
    skudObjectId: contract.skud_object_id,
    entityKind: 'addendum',
    entityId: row.id,
    action: 'create',
    after: { ...row },
    actor,
  });
  return row;
}

async function lockAddendum(
  client: PoolClient,
  addendumId: string,
): Promise<{ addendum: ObjectAddendumRow; contract: ObjectContractRow }> {
  const result = await client.query<ObjectAddendumRow>(
    `SELECT ${ADDENDUM_COLUMNS} FROM object_contract_addenda WHERE id = $1 FOR UPDATE`,
    [addendumId],
  );
  const addendum = result.rows[0];
  if (!addendum) failNotFound('Допсоглашение');
  // Договор блокируется вторым — порядок «сначала дочерняя, потом родительская» выдержан
  // во всех операциях модуля, иначе получим взаимную блокировку.
  const contract = await lockContract(client, addendum.contract_id);
  return { addendum, contract };
}

/** Подписанную запись править нельзя — только аннулировать и завести новую (п. «Жизненный цикл»). */
export const assertDraft = (status: EntryStatus, what: string): void => {
  if (status !== 'draft') {
    failWith({
      http: 409,
      code: 'not_draft',
      message: `${what} уже подписано или аннулировано — правка запрещена`,
    });
  }
};

export async function updateAddendum(
  client: PoolClient,
  actor: ObjectKpiActor,
  addendumId: string,
  expectedVersion: number,
  patch: Partial<AddendumInput>,
): Promise<ObjectAddendumRow> {
  const { addendum, contract } = await lockAddendum(client, addendumId);
  assertDraft(addendum.status, 'Допсоглашение');

  const fields = ['addendum_number', 'addendum_date', 'effective_date', 'amount_delta', 'notes'] as const;
  const entries = fields
    .filter((f) => patch[f] !== undefined)
    .map((f) => [f, patch[f]] as const);
  if (entries.length === 0) return addendum;

  const setSql = entries.map(([field], i) => `${field} = $${i + 4}`).join(', ');
  let after: ObjectAddendumRow | undefined;
  try {
    const result = await client.query<ObjectAddendumRow>(
      `UPDATE object_contract_addenda
          SET ${setSql}, version = version + 1, updated_by = $3, updated_at = now()
        WHERE id = $1 AND version = $2
        RETURNING ${ADDENDUM_COLUMNS}`,
      [addendumId, expectedVersion, actor.userId, ...entries.map(([, value]) => value)],
    );
    after = result.rows[0];
  } catch (error) {
    return rethrowUnique(error, 'Допсоглашение с таким номером уже есть в договоре');
  }
  if (!after) failStaleVersion();

  await recordObjectKpiHistory(client, {
    skudObjectId: contract.skud_object_id,
    entityKind: 'addendum',
    entityId: addendumId,
    action: 'update',
    before: { ...addendum },
    after: { ...after },
    actor,
  });
  return after;
}

export async function setAddendumStatus(
  client: PoolClient,
  actor: ObjectKpiActor,
  addendumId: string,
  nextStatus: 'signed' | 'cancelled',
  expectedVersion: number,
  reason?: string | null,
): Promise<ObjectAddendumRow> {
  const { addendum, contract } = await lockAddendum(client, addendumId);

  if (addendum.status === nextStatus) return addendum;
  // Возврат в draft запрещён, аннулированное не воскрешается.
  if (nextStatus === 'signed' && addendum.status !== 'draft') {
    failWith({ http: 409, code: 'bad_transition', message: 'Аннулированное допсоглашение подписать нельзя' });
  }

  const impactMonth = addendumImpactMonth(addendum.effective_date);
  await requireReasonIfMonthFixed(client, contract.skud_object_id, impactMonth, reason);

  if (nextStatus === 'signed') {
    await assertContractTotalNonNegative(
      client,
      contract.id,
      Number(contract.base_amount),
      Number(addendum.amount_delta),
    );
  }

  const result = await client.query<ObjectAddendumRow>(
    `UPDATE object_contract_addenda
        SET status = $4, version = version + 1, updated_by = $3, updated_at = now()
      WHERE id = $1 AND version = $2
      RETURNING ${ADDENDUM_COLUMNS}`,
    [addendumId, expectedVersion, actor.userId, nextStatus],
  );
  const after = result.rows[0];
  if (!after) failStaleVersion();

  await recordObjectKpiHistory(client, {
    skudObjectId: contract.skud_object_id,
    entityKind: 'addendum',
    entityId: addendumId,
    action: 'update',
    before: { ...addendum },
    after: { ...after },
    changedFields: ['status'],
    reason,
    actor,
  });
  return after;
}

export async function deleteAddendum(
  client: PoolClient,
  actor: ObjectKpiActor,
  addendumId: string,
  expectedVersion: number,
): Promise<void> {
  const { addendum, contract } = await lockAddendum(client, addendumId);
  assertDraft(addendum.status, 'Допсоглашение');

  const result = await client.query(
    'DELETE FROM object_contract_addenda WHERE id = $1 AND version = $2',
    [addendumId, expectedVersion],
  );
  if ((result.rowCount ?? 0) === 0) failStaleVersion();

  await recordObjectKpiHistory(client, {
    skudObjectId: contract.skud_object_id,
    entityKind: 'addendum',
    entityId: addendumId,
    action: 'delete',
    before: { ...addendum },
    actor,
  });
}

// ─── КС-2 и уменьшения объёма ───────────────────────────────────────────────

export async function listKs2Entries(contractId: string): Promise<ObjectKs2Row[]> {
  return query<ObjectKs2Row>(
    `SELECT ${KS2_COLUMNS} FROM object_ks2_entries
      WHERE contract_id = $1
      ORDER BY customer_signed_date, created_at`,
    [contractId],
  );
}

export interface Ks2Input {
  entry_kind: 'act' | 'reduction';
  /** Всегда положительное число: знак ставит сервис по entry_kind. */
  amount: number | string;
  /** Необязателен: без номера сервер берёт следующий порядковый по договору. */
  act_number?: string | null;
  /** Расчётный месяц (YYYY-MM или YYYY-MM-01) — основной способ ввода из интерфейса. */
  period_month?: string | null;
  /** Точная дата подписания заказчиком. Оставлена для переноса реальных актов через API. */
  customer_signed_date?: string | null;
  notes?: string | null;
  source?: 'manual' | 'fact_adjustment';
}

/**
 * Дата подписания для записи, заведённой месяцем: последний день месяца, а для текущего —
 * сегодня по Москве. Акт с датой подписания в будущем выглядит как ошибка ввода.
 *
 * Живёт здесь, а не в fact-adjustment: месяцем заводятся и обычные акты из формы КС-2,
 * а тот модуль уже импортирует этот — обратной зависимости не возникает.
 */
export function signedDateForMonth(periodMonth: string): string {
  const today = moscowTodayIso();
  const [year, month] = periodMonth.slice(0, 7).split('-').map(Number);
  // Нулевой день следующего месяца = последний день текущего.
  const lastDay = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  return lastDay > today ? today : lastDay;
}

/**
 * Будущий месяц отклоняется ДО вставки. Без этой проверки signedDateForMonth зажал бы дату
 * сегодняшним днём, и акт, заведённый на сентябрь, молча лёг бы в август.
 */
function assertNotFutureMonth(periodMonth: string): void {
  if (periodMonth.slice(0, 7) > moscowTodayIso().slice(0, 7)) {
    failWith({
      http: 400,
      code: 'future_month',
      message: 'Месяц акта не может быть будущим',
    });
  }
}

/**
 * Дата подписания из ввода: либо месяц, либо точная дата, но не оба сразу — два
 * противоречащих периода в одном теле запроса молча разрешать нельзя.
 */
function resolveKs2SignedDate(input: Pick<Ks2Input, 'period_month' | 'customer_signed_date'>): string {
  const month = input.period_month ? input.period_month.slice(0, 7) : null;
  const exact = input.customer_signed_date ?? null;

  if (month && exact) {
    failWith({
      http: 400,
      code: 'ambiguous_period',
      message: 'Укажите либо месяц акта, либо дату подписания',
    });
  }
  if (!month && !exact) {
    failWith({ http: 400, code: 'period_required', message: 'Укажите месяц акта' });
  }

  // Проверяется ЗАПРОШЕННЫЙ месяц, а не итоговая дата: signedDateForMonth зажимает будущее
  // сегодняшним днём, и проверка после неё пропустила бы акт, заведённый на сентябрь.
  assertNotFutureMonth(month ?? exact!.slice(0, 7));
  return month ? signedDateForMonth(month) : exact!;
}

/**
 * Следующий номер акта по договору.
 *
 * Считаются ТОЛЬКО полностью числовые номера: «КС-2 №1/2026» после вычистки нецифр дал бы
 * 212026, и следующий акт получил бы номер 212027. Ограничение в 18 знаков защищает
 * приведение к bigint от переполнения.
 *
 * Последовательность общая для актов и уменьшений — для человека это один журнал записей
 * договора. Уникальный индекс включает entry_kind, поэтому общая нумерация ему не мешает.
 *
 * Гонок нет: вызывается под lockContract (FOR UPDATE по договору), внутри той же транзакции.
 */
async function nextActNumber(client: PoolClient, contractId: string): Promise<string> {
  const result = await client.query<{ next_number: string }>(
    `SELECT (COALESCE(MAX(btrim(act_number)::bigint), 0) + 1)::text AS next_number
       FROM object_ks2_entries
      WHERE contract_id = $1
        AND btrim(act_number) ~ '^[0-9]{1,18}$'`,
    [contractId],
  );
  return result.rows[0]?.next_number ?? '1';
}

/**
 * Уменьшение объёма (п. 3.3) хранится отрицательным — на этом держатся и накопительный
 * объём, и факт месяца. Знак ставится здесь, а не на клиенте: форма даёт модуль суммы,
 * и «минус, введённый руками» не должен превращать уменьшение в акт.
 */
const signedAmount = (kind: 'act' | 'reduction', amount: number | string): number => {
  const value = Math.abs(Number(amount));
  if (!Number.isFinite(value) || value === 0) {
    failWith({ http: 400, code: 'bad_amount', message: 'Сумма должна быть положительным числом' });
  }
  return kind === 'reduction' ? -value : value;
};

export async function createKs2Entry(
  client: PoolClient,
  actor: ObjectKpiActor,
  contractId: string,
  input: Ks2Input,
): Promise<ObjectKs2Row> {
  const contract = await lockContract(client, contractId);
  const signedDate = resolveKs2SignedDate(input);
  const actNumber = input.act_number?.trim()
    ? input.act_number.trim()
    : await nextActNumber(client, contractId);

  let row: ObjectKs2Row;
  try {
    const result = await client.query<ObjectKs2Row>(
      `INSERT INTO object_ks2_entries (
         contract_id, skud_object_id, entry_kind, amount, act_number,
         customer_signed_date, status, source, notes, created_by, updated_by
       ) VALUES ($1,$2,$3,$4,$5,$6,'draft',$7,$8,$9,$9)
       RETURNING ${KS2_COLUMNS}`,
      [
        contractId,
        contract.skud_object_id,
        input.entry_kind,
        signedAmount(input.entry_kind, input.amount),
        actNumber,
        signedDate,
        input.source ?? 'manual',
        input.notes ?? null,
        actor.userId,
      ],
    );
    row = result.rows[0];
  } catch (error) {
    return rethrowUnique(error, 'Запись с таким номером акта уже есть в договоре');
  }

  await recordObjectKpiHistory(client, {
    skudObjectId: contract.skud_object_id,
    entityKind: 'ks2',
    entityId: row.id,
    action: 'create',
    after: { ...row },
    actor,
  });
  return row;
}

async function lockKs2Entry(client: PoolClient, entryId: string): Promise<ObjectKs2Row> {
  const result = await client.query<ObjectKs2Row>(
    `SELECT ${KS2_COLUMNS} FROM object_ks2_entries WHERE id = $1 FOR UPDATE`,
    [entryId],
  );
  const row = result.rows[0];
  if (!row) failNotFound('Акт КС-2');
  return row;
}

/**
 * Что разрешено править у ПОДПИСАННОЙ записи: месяц, сумма и примечание.
 *
 * Номер акта — ссылка на бумажный документ, вид записи меняет знак суммы, source отличает
 * корректировку факта от ручного ввода, а прямая customer_signed_date дала бы второй способ
 * сдвинуть месяц мимо проверки будущего. Всё это у подписанной записи заблокировано.
 */
const KS2_SIGNED_PATCHABLE = new Set(['period_month', 'amount', 'notes']);

/**
 * Правка записи КС-2.
 *
 * Черновик правится целиком. Подписанная — только месяцем, суммой и примечанием, и с
 * основанием, если задет закрытый месяц (СТАРЫЙ или НОВЫЙ: перенос акта меняет факт обоих).
 * Аннулированная не правится вовсе.
 */
export async function updateKs2Entry(
  client: PoolClient,
  actor: ObjectKpiActor,
  entryId: string,
  expectedVersion: number,
  patch: Partial<Ks2Input>,
  reason?: string | null,
): Promise<ObjectKs2Row> {
  const before = await lockKs2Entry(client, entryId);
  if (before.status === 'cancelled') {
    failWith({
      http: 409,
      code: 'bad_transition',
      message: 'Аннулированный акт не редактируется',
    });
  }
  if (before.status === 'signed') {
    // Молча игнорировать лишнее поле нельзя: клиент решит, что номер акта изменён.
    const locked = Object.entries(patch)
      .filter(([key, value]) => value !== undefined && !KS2_SIGNED_PATCHABLE.has(key))
      .map(([key]) => key);
    if (locked.length > 0) {
      failWith({
        http: 400,
        code: 'signed_field_locked',
        message: `У подписанной записи правятся только месяц и сумма: ${locked.join(', ')}`,
      });
    }
  }

  const values: Array<[string, unknown]> = [];
  let nextMonth: string | null = null;
  if (patch.period_month !== undefined && patch.period_month !== null) {
    nextMonth = `${patch.period_month.slice(0, 7)}-01`;
    assertNotFutureMonth(nextMonth);
    values.push(['customer_signed_date', signedDateForMonth(nextMonth)]);
  } else if (patch.customer_signed_date !== undefined && patch.customer_signed_date !== null) {
    nextMonth = `${patch.customer_signed_date.slice(0, 7)}-01`;
    assertNotFutureMonth(nextMonth);
    values.push(['customer_signed_date', patch.customer_signed_date]);
  }
  if (patch.act_number !== undefined) values.push(['act_number', patch.act_number]);
  if (patch.notes !== undefined) values.push(['notes', patch.notes]);
  // Сумма и вид записи связаны знаком, поэтому пересчитываются вместе.
  if (patch.amount !== undefined || patch.entry_kind !== undefined) {
    const kind = patch.entry_kind ?? before.entry_kind;
    values.push(['entry_kind', kind]);
    values.push(['amount', signedAmount(kind, patch.amount ?? before.amount)]);
  }
  if (values.length === 0) return before;

  // Черновик в факт не входит, поэтому основания не требует. У подписанной записи проверяются
  // ОБА месяца: перенос из закрытого февраля в открытый март меняет факт февраля тоже.
  if (before.status === 'signed') {
    await requireReasonIfMonthFixed(client, before.skud_object_id, before.period_month, reason);
    if (nextMonth && nextMonth !== before.period_month) {
      await requireReasonIfMonthFixed(client, before.skud_object_id, nextMonth, reason);
    }
  }

  const setSql = values.map(([field], i) => `${field} = $${i + 4}`).join(', ');
  let after: ObjectKs2Row | undefined;
  try {
    const result = await client.query<ObjectKs2Row>(
      `UPDATE object_ks2_entries
          SET ${setSql}, version = version + 1, updated_by = $3, updated_at = now()
        WHERE id = $1 AND version = $2
        RETURNING ${KS2_COLUMNS}`,
      [entryId, expectedVersion, actor.userId, ...values.map(([, value]) => value)],
    );
    after = result.rows[0];
  } catch (error) {
    return rethrowUnique(error, 'Запись с таким номером акта уже есть в договоре');
  }
  if (!after) failStaleVersion();

  await recordObjectKpiHistory(client, {
    skudObjectId: before.skud_object_id,
    entityKind: 'ks2',
    entityId: entryId,
    action: 'update',
    before: { ...before },
    after: { ...after },
    reason,
    actor,
  });
  return after;
}

export async function setKs2Status(
  client: PoolClient,
  actor: ObjectKpiActor,
  entryId: string,
  nextStatus: 'signed' | 'cancelled',
  expectedVersion: number,
  reason?: string | null,
): Promise<ObjectKs2Row> {
  const before = await lockKs2Entry(client, entryId);

  if (before.status === nextStatus) return before;
  if (nextStatus === 'signed' && before.status !== 'draft') {
    failWith({ http: 409, code: 'bad_transition', message: 'Аннулированный акт подписать нельзя' });
  }

  // Факт месяца меняется в обе стороны: и подписание, и аннулирование закрытого месяца
  // требуют основания.
  await requireReasonIfMonthFixed(client, before.skud_object_id, before.period_month, reason);

  const result = await client.query<ObjectKs2Row>(
    `UPDATE object_ks2_entries
        SET status = $4, version = version + 1, updated_by = $3, updated_at = now()
      WHERE id = $1 AND version = $2
      RETURNING ${KS2_COLUMNS}`,
    [entryId, expectedVersion, actor.userId, nextStatus],
  );
  const after = result.rows[0];
  if (!after) failStaleVersion();

  await recordObjectKpiHistory(client, {
    skudObjectId: before.skud_object_id,
    entityKind: 'ks2',
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

export async function deleteKs2Entry(
  client: PoolClient,
  actor: ObjectKpiActor,
  entryId: string,
  expectedVersion: number,
): Promise<void> {
  const before = await lockKs2Entry(client, entryId);
  assertDraft(before.status, 'Акт КС-2');

  const result = await client.query(
    'DELETE FROM object_ks2_entries WHERE id = $1 AND version = $2',
    [entryId, expectedVersion],
  );
  if ((result.rowCount ?? 0) === 0) failStaleVersion();

  await recordObjectKpiHistory(client, {
    skudObjectId: before.skud_object_id,
    entityKind: 'ks2',
    entityId: entryId,
    action: 'delete',
    before: { ...before },
    actor,
  });
}
