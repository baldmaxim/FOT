/**
 * Ведомости выплаты из 1С по API (миграция 379): POST /api/public/v1/payroll/payouts[?dry_run=1] (XML «зп_документы_31»)
 * и POST /payroll/payouts/cancel (распроведение или удаление в 1С).
 *
 * Один запрос — одна транзакция: блокировки ГУИДов и номеров без ожидания (занято — 409 busy), решения по каждой
 * ведомости (правила — payroll-1c-payouts.api.rules.ts), запись. Конфликт версии или денег в любой ведомости — 409,
 * ничего не записано. dry_run — всё то же и ROLLBACK. Пишется под SET LOCAL fot.payout_writer = 'api' (триггер 379).
 * Каждая выгрузка с изменениями — строка payroll_1c_payout_api_batches со снимками «до» (откат —
 * payroll-1c-payouts.api-rollback.ts). Отмена удаляет строки ведомости (суммы уходят из «Выплат на карту» и
 * «Остатка»), шапка и журнал остаются; новая версия после отмены возвращает строки (restore).
 * Ведомость из файла (тот же ГУИД или номер и дата) переходит под API — adopt; решения ФОТ (перенос месяца, сотрудник
 * вручную) переносятся на строки из 1С (carryFotDecisions). После записи — сверка «ЗП к выплате» (to-pay.ts).
 */
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

import { getPool } from '../../config/postgres.js';
import {
  carryFotDecisions,
  compareForeignPayout,
  decidePayoutCancel,
  decidePayoutPost,
  payoutApiHash,
  type IFotLineDecision,
  type IPayoutApiState,
  type IStoredPayoutDoc,
  type PayoutApiAction,
  type PayoutApiCancelAction,
} from './payroll-1c-payouts.api.rules.js';
import { resolvePayoutApiLines, type IPayoutApiLineTarget } from './payroll-1c-payouts.api-lines.js';
import {
  assertDocTotals,
  centsText,
  insertApiLines,
  loadApiStates,
  loadDocsByGuid,
  loadDocsByNumber,
  loadLastCancelLines,
  payoutDocLockKeys,
  payoutGuidLockKey,
  rowsOf,
  saveApiState,
  snapshotDoc,
  tryPayoutLocks,
  writeApiJournal,
} from './payroll-1c-payouts.api.store.js';
import { parsePayout1cApiXml, type IPayoutApiDocument } from './payroll-1c-payouts.month-xml.js';
import { reconcileToPayLines, toPayWarning, type IToPayChange } from './payroll-1c-payouts.to-pay.js';

export class PayoutApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly details: unknown[] = [],
  ) {
    super(message);
  }
}

const busy = (): PayoutApiError => new PayoutApiError(409, 'busy', 'Ведомости сейчас принимаются — повторите позже', true);

export interface IPayoutApiDocResult {
  index: number;
  guid: string;
  doc_number: string;
  doc_date: string;
  period_month: string;
  organization_inn: string;
  payment_method: string;
  version: number | null;
  action: PayoutApiAction;
  total: string;
  lines: number;
  lines_matched: number | null;
  lines_unmatched: number | null;
  unmatched: Array<{ full_name: string; amount: string; reason: string }>;
  differences: string[];
  warnings: string[];
}

/** Снимок одной ведомости в выгрузке: что было до и стало после — для отката. */
interface IBatchChange {
  guid: string;
  document_id: number | null;
  action: string;
  before: { state: Record<string, unknown> | null; document: Record<string, unknown> | null; lines: Array<Record<string, unknown>> };
  after: { version: number; state: 'active' | 'cancelled'; api_hash: string | null; revision: number | null };
}

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

const begin = async (client: PoolClient): Promise<void> => {
  await client.query('BEGIN');
  await client.query("SET LOCAL fot.payout_writer = 'api'");
};

const stateRow = (state: (IPayoutApiState & { raw: Record<string, unknown> }) | undefined): Record<string, unknown> | null => (
  state ? state.raw : null
);

const resultOf = (doc: IPayoutApiDocument, action: PayoutApiAction, targets: readonly IPayoutApiLineTarget[] | null,
  differences: string[] = [], extraWarnings: readonly string[] = []): IPayoutApiDocResult => {
  const amountByKey = new Map(doc.lines.map(line => [line.lineKey, line.amountCents]));
  const nameByKey = new Map(doc.lines.map(line => [line.lineKey, line.fullName]));
  return {
    index: doc.index,
    guid: doc.guid,
    doc_number: doc.docNumber,
    doc_date: doc.docDate,
    period_month: doc.periodMonth.slice(0, 7),
    organization_inn: doc.organizationInn,
    payment_method: doc.paymentMethod,
    version: doc.version,
    action,
    total: centsText(doc.totalCents),
    lines: doc.lines.length,
    lines_matched: targets ? targets.filter(target => target.employeeId !== null).length : null,
    lines_unmatched: targets ? targets.filter(target => target.employeeId === null).length : null,
    unmatched: (targets ?? []).filter(target => target.employeeId === null).map(target => ({
      full_name: nameByKey.get(target.lineKey) ?? '', amount: centsText(amountByKey.get(target.lineKey) ?? 0), reason: target.reason,
    })),
    differences,
    warnings: [
      ...(targets ?? []).map(target => target.warning).filter((warning): warning is string => warning !== null),
      ...extraWarnings,
    ],
  };
};

/** Предупреждения «ЗП к выплате» — к ведомости, которая сняла строку; нет такой в ответе — к первой. */
const attachToPayWarnings = <T extends { guid: string; warnings: string[] }>(results: T[], changes: readonly IToPayChange[]): void => {
  for (const change of changes) {
    const target = results.find(result => result.guid === change.byGuid) ?? results[0];
    target?.warnings.push(toPayWarning(change));
  }
};

const insertBatch = async (client: PoolClient, input: { batchId: string; kind: 'payouts' | 'cancel'; keyId: string | null; bodySha: string }) => {
  await client.query(
    `INSERT INTO payroll_1c_payout_api_batches (batch_id, kind, data_api_key_id, body_sha256, changes)
     VALUES ($1::uuid, $2, $3::uuid, $4, '[]'::jsonb)`,
    [input.batchId, input.kind, input.keyId, input.bodySha],
  );
};

const finishBatch = async (client: PoolClient, batchId: string, changes: readonly IBatchChange[]): Promise<void> => {
  await client.query('UPDATE payroll_1c_payout_api_batches SET changes = $2::jsonb WHERE batch_id = $1::uuid', [batchId, JSON.stringify(changes)]);
};

/**
 * Запись одной ведомости (new / replace / restore / adopt) — документ, строки, журнал. Решения ФОТ прежних строк
 * (перенос месяца, сотрудник вручную) переносятся; у restore прежние строки — из снимка последней отмены. adopt —
 * ведомость из файла: ГУИД — из 1С, origin — api; её месяц в ФОТ ≠ периоду 1С — перенос строк в месяц ФОТ.
 */
const writeDoc = async (client: PoolClient, doc: IPayoutApiDocument, action: 'new' | 'replace' | 'restore' | 'adopt',
  stored: IStoredPayoutDoc | null, targets: readonly IPayoutApiLineTarget[], ctx: { keyId: string | null; batchId: string; bodySha: string }) => {
  const amounts = new Map(doc.lines.map(line => [line.lineKey, line.amountCents]));
  let documentId: number;
  let revisionBefore = 0;
  let previous: Awaited<ReturnType<typeof snapshotDoc>> = null;
  let oldLines: IFotLineDecision[] = [];
  let docMovedTo: string | null = null;
  if (action === 'new') {
    const [row] = await rowsOf<{ id: string }>(
      client,
      `INSERT INTO payroll_1c_payout_documents (doc_guid, doc_number, zup2_number, doc_date, period_month, payment_method,
         salary_project, organization_inn, total_amount, content_hash, revision, updated_by, source, origin, comment)
       VALUES ($1::uuid, $2, NULL, $3::date, $4::date, $5, $6, $7, $8::numeric, $9, 1, NULL, '1c', 'api', $10) RETURNING id`,
      [doc.guid, doc.docNumber, doc.docDate, doc.periodMonth, doc.paymentMethod, doc.salaryProject, doc.organizationInn,
        centsText(doc.totalCents), doc.contentHash, doc.comment],
    );
    documentId = Number(row.id);
  } else {
    documentId = (stored as IStoredPayoutDoc).id;
    previous = await snapshotDoc(client, documentId);
    revisionBefore = Number(previous?.header.revision ?? 0);
    oldLines = (previous?.lines ?? []) as unknown as IFotLineDecision[];
    if (action === 'restore' && oldLines.length === 0) oldLines = await loadLastCancelLines(client, documentId);
    if (action === 'adopt' && previous && String(previous.header.period_month) !== doc.periodMonth) {
      docMovedTo = String(previous.header.period_month);
    }
    await client.query(
      `UPDATE payroll_1c_payout_documents SET doc_number = $2, doc_date = $3::date, period_month = $4::date, payment_method = $5,
         salary_project = $6, organization_inn = $7, total_amount = $8::numeric, content_hash = $9, comment = $10,
         doc_guid = $11::uuid, origin = 'api', revision = revision + 1, updated_at = now(), updated_by = NULL
       WHERE id = $1`,
      [documentId, doc.docNumber, doc.docDate, doc.periodMonth, doc.paymentMethod, doc.salaryProject, doc.organizationInn,
        centsText(doc.totalCents), doc.contentHash, doc.comment, doc.guid],
    );
    await client.query('DELETE FROM payroll_1c_payout_lines WHERE document_id = $1', [documentId]);
  }
  const carried = carryFotDecisions({
    docPeriod: doc.periodMonth,
    docMovedTo,
    oldLines,
    targets: targets.map(target => ({ ...target, amountCents: amounts.get(target.lineKey) ?? 0 })),
  });
  await insertApiLines(client, documentId, doc, carried.lines);
  if (!(await assertDocTotals(client, documentId, doc.lines.length))) {
    throw new PayoutApiError(400, 'invalid_xml', `Ведомость ${doc.docNumber}: сумма строк не равна итогу — ничего не записано`, false);
  }
  // Сотрудник строки — после переноса решений ФОТ: по нему счётчики журнала и ответа.
  const finalTargets = targets.map(target => {
    const line = carried.lines.get(target.lineKey);
    return line ? { ...target, employeeId: line.employeeId, resolution: line.resolution, reason: line.reason } : target;
  });
  await writeApiJournal(client, {
    documentId,
    action,
    revisionBefore,
    contentHashBefore: previous ? String(previous.header.content_hash) : null,
    contentHashAfter: doc.contentHash,
    previousHeader: action === 'replace' || action === 'adopt' ? previous?.header ?? null : null,
    previousLines: action === 'new' ? null : previous?.lines ?? [],
    bodySha256: ctx.bodySha,
    targets: finalTargets,
    amountsCents: amounts,
    keyId: ctx.keyId,
    batchId: ctx.batchId,
  });
  return { documentId, revision: revisionBefore + 1, previous, warnings: carried.warnings, finalTargets };
};

/** Приём ведомостей из 1С. Ошибка разбора XML — Payout1cParseError (контроллер — 400 invalid_xml). */
export const applyPayoutsApi = async (input: { xml: string; keyId: string | null; dryRun: boolean }): Promise<IPayoutApiDocResult[]> => {
  const docs = parsePayout1cApiXml(input.xml);
  const withoutVersion = docs.filter(doc => doc.version === null);
  if (!input.dryRun && withoutVersion.length > 0) {
    throw new PayoutApiError(400, 'version_required', 'Без «Док_Версия» ведомость принимается только на проверку (?dry_run=1)', false,
      withoutVersion.map(doc => ({ index: doc.index, guid: doc.guid, message: `${doc.docNumber}: нет «Док_Версия»` })));
  }
  const bodySha = sha256(input.xml);
  const client = await getPool().connect();
  try {
    await begin(client);
    if (!(await tryPayoutLocks(client, payoutDocLockKeys(docs)))) throw busy();
    const guids = docs.map(doc => doc.guid);
    const [states, byGuid, byNumber] = [await loadApiStates(client, guids), await loadDocsByGuid(client, guids), await loadDocsByNumber(client, docs)];

    const plans = docs.map(doc => {
      const apiHash = payoutApiHash(doc);
      const decision = decidePayoutPost({
        state: states.get(doc.guid), version: doc.version, apiHash, byGuid: byGuid.get(doc.guid) ?? null, byNumber: byNumber.get(doc.guid) ?? null,
      });
      const comparison = decision.kind === 'foreign' || (decision.kind === 'apply' && decision.action === 'adopt')
        ? compareForeignPayout(doc, decision.stored) : null;
      return { doc, apiHash, decision, comparison };
    });
    const conflicts = plans.flatMap(plan => {
      if (plan.decision.kind === 'conflict') return [{ index: plan.doc.index, guid: plan.doc.guid, code: plan.decision.code, message: plan.decision.message }];
      if (plan.decision.kind === 'foreign' && plan.comparison && !plan.comparison.sameMoney) {
        return [{ index: plan.doc.index, guid: plan.doc.guid, code: 'duplicate_conflict', message: plan.comparison.differences.join('; ') }];
      }
      return [];
    });
    if (conflicts.length > 0) {
      throw new PayoutApiError(409, conflicts[0].code, 'Ведомости не приняты — в ФОТ эти документы с другими данными', false, conflicts);
    }

    const batchId = randomUUID();
    const changes: IBatchChange[] = [];
    if (plans.some(plan => plan.decision.kind === 'apply')) await insertBatch(client, { batchId, kind: 'payouts', keyId: input.keyId, bodySha });
    const results: IPayoutApiDocResult[] = [];
    for (const { doc, apiHash, decision, comparison } of plans) {
      if (decision.kind === 'foreign') {
        results.push(resultOf(doc, 'already_loaded', null, comparison?.differences ?? []));
        continue;
      }
      if (decision.kind === 'skip') {
        results.push(resultOf(doc, decision.action, null));
        continue;
      }
      if (decision.kind !== 'apply') continue;
      const state = states.get(doc.guid);
      const stored = decision.action === 'adopt' ? decision.stored : byGuid.get(doc.guid) ?? null;
      const version = doc.version ?? (state?.version ?? 0) + 1;
      const targets = await resolvePayoutApiLines(doc);
      if (decision.action === 'unchanged') {
        await saveApiState(client, { guid: doc.guid, version, state: 'active', apiHash, documentId: stored?.id ?? null, keyId: input.keyId });
        changes.push({
          guid: doc.guid, document_id: stored?.id ?? null, action: 'unchanged',
          before: { state: stateRow(state), document: null, lines: [] },
          after: { version, state: 'active', api_hash: apiHash, revision: null },
        });
        results.push(resultOf(doc, 'unchanged', targets));
        continue;
      }
      const written = await writeDoc(client, doc, decision.action, stored, targets, { keyId: input.keyId, batchId, bodySha });
      await saveApiState(client, { guid: doc.guid, version, state: 'active', apiHash, documentId: written.documentId, keyId: input.keyId });
      changes.push({
        guid: doc.guid, document_id: written.documentId, action: decision.action,
        before: { state: stateRow(state), document: written.previous?.header ?? null, lines: written.previous?.lines ?? [] },
        after: { version, state: 'active', api_hash: apiHash, revision: written.revision },
      });
      results.push(resultOf(doc, decision.action === 'adopt' ? 'adopted' : decision.action, written.finalTargets,
        decision.action === 'adopt' ? comparison?.differences ?? [] : [], written.warnings));
    }
    if (changes.length > 0) {
      attachToPayWarnings(results, await reconcileToPayLines(client, { batchId, keyId: input.keyId, bodySha }));
      await finishBatch(client, batchId, changes);
    }
    await client.query(input.dryRun ? 'ROLLBACK' : 'COMMIT');
    return results;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
};

export interface IPayoutCancelResult {
  index: number;
  guid: string;
  version: number;
  action: PayoutApiCancelAction;
  /** Снятые или возвращённые строки «ЗП к выплате» и прочие замечания. */
  warnings: string[];
  /**
   * Есть ли в ФОТ ведомость с этим ГУИДом. false — записана только отметка отмены (поздняя отправка этой версии её не
   * создаст); если ведомость загружали в ФОТ файлом под другим ГУИДом, её суммы не изменились — отменяет бухгалтер ФОТ.
   */
  found: boolean;
}

/** Отмена ведомостей (распроведение или удаление в 1С). Массив атомарен: конфликт в одной — ничего не применено. */
export const cancelPayoutsApi = async (input: {
  items: ReadonlyArray<{ guid: string; version: number }>;
  keyId: string | null;
  bodySha: string;
}): Promise<IPayoutCancelResult[]> => {
  const client = await getPool().connect();
  try {
    await begin(client);
    const guids = input.items.map(item => item.guid);
    if (!(await tryPayoutLocks(client, guids.map(payoutGuidLockKey)))) throw busy();
    const [states, byGuid] = [await loadApiStates(client, guids), await loadDocsByGuid(client, guids)];
    const plans = input.items.map((item, index) => ({
      item, index, decision: decidePayoutCancel({ state: states.get(item.guid), version: item.version, byGuid: byGuid.get(item.guid) ?? null }),
    }));
    const conflicts = plans.flatMap(plan => (plan.decision.kind === 'conflict'
      ? [{ index: plan.index, guid: plan.item.guid, code: plan.decision.code, message: plan.decision.message }] : []));
    if (conflicts.length > 0) {
      throw new PayoutApiError(409, conflicts[0].code, 'Отмена не принята — ничего не изменено', false, conflicts);
    }
    const batchId = randomUUID();
    const changes: IBatchChange[] = [];
    if (plans.some(plan => plan.decision.kind === 'apply')) await insertBatch(client, { batchId, kind: 'cancel', keyId: input.keyId, bodySha: input.bodySha });
    const results: IPayoutCancelResult[] = [];
    for (const { item, index, decision } of plans) {
      if (decision.kind === 'skip') {
        results.push({ index, guid: item.guid, version: item.version, action: decision.action, found: byGuid.has(item.guid), warnings: [] });
        continue;
      }
      const state = states.get(item.guid);
      const stored = byGuid.get(item.guid) ?? null;
      let previous: Awaited<ReturnType<typeof snapshotDoc>> = null;
      let revision: number | null = null;
      if (stored && stored.lines > 0) {
        previous = await snapshotDoc(client, stored.id);
        const revisionBefore = Number(previous?.header.revision ?? 0);
        await client.query('DELETE FROM payroll_1c_payout_lines WHERE document_id = $1', [stored.id]);
        await client.query('UPDATE payroll_1c_payout_documents SET revision = revision + 1, updated_at = now(), updated_by = NULL WHERE id = $1', [stored.id]);
        await writeApiJournal(client, {
          documentId: stored.id, action: 'cancel', revisionBefore,
          contentHashBefore: String(previous?.header.content_hash), contentHashAfter: String(previous?.header.content_hash),
          previousHeader: null, previousLines: previous?.lines ?? [], bodySha256: input.bodySha,
          targets: [], amountsCents: new Map(), keyId: input.keyId, batchId,
        });
        revision = revisionBefore + 1;
      }
      await saveApiState(client, {
        guid: item.guid, version: item.version, state: 'cancelled', apiHash: state?.apiHash ?? null, documentId: stored?.id ?? null, keyId: input.keyId,
      });
      changes.push({
        guid: item.guid, document_id: stored?.id ?? null, action: 'cancel',
        before: { state: stateRow(state), document: previous?.header ?? null, lines: previous?.lines ?? [] },
        after: { version: item.version, state: 'cancelled', api_hash: state?.apiHash ?? null, revision },
      });
      results.push({ index, guid: item.guid, version: item.version, action: 'cancelled', found: stored !== null, warnings: [] });
    }
    if (changes.length > 0) {
      attachToPayWarnings(results, await reconcileToPayLines(client, { batchId, keyId: input.keyId, bodySha: input.bodySha }));
      await finishBatch(client, batchId, changes);
    }
    await client.query('COMMIT');
    return results;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
};
