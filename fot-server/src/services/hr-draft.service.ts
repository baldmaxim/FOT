/**
 * Черновик мастера «Добавить сотрудника» — контейнер для сканов до того, как
 * сотрудник существует. Сотрудника создаёт существующий POST /api/employees
 * (его код не трогаем), мастер лишь прикрепляет к созданному профиль и файлы:
 *
 *   draft → (POST /api/employees) → employee_created_pending_attach → attach → attached
 *
 * attach идемпотентен: повтор не дублирует ни документы, ни профиль. Если он упал,
 * черновик остаётся в employee_created_pending_attach с сохранённым employee_id —
 * повторное создание сотрудника из этого состояния невозможно, только «Повторить
 * прикрепление».
 */
import type { PoolClient } from 'pg';
import { execute, query, queryOne, withTransaction } from '../config/postgres.js';
import { decryptJson, encryptJson } from './hr-crypto.service.js';
import {
  applyProfilePatch,
  createProfile,
  listCitizenships,
  loadProfileRow,
  recordHistory,
  rowToPlainFields,
  type IHrActor,
  type IHrProfileInput,
} from './hr-profile.service.js';
import {
  attachDraftDocumentsToEmployee,
  listDraftHrDocumentRows,
  readRecognitionResult,
  toPublic,
  type IHrDocumentPublic,
} from './hr-documents.service.js';
import { buildOcrApplyPlan, buildProfilePatchFromOcr, type HrOcrPatch } from './hr-ocr/apply.js';
import { applyOcrToEmployee } from './hr-ocr/apply-employee.js';
import { getHrDocumentType, type HrOcrType } from '../config/hr-documents.js';
import { resolveOcrType } from './hr-ocr/normalize.js';

export type DraftState = 'draft' | 'employee_created_pending_attach' | 'attached' | 'expired';

export interface IDraftPayload {
  full_name?: string | null;
  hire_date?: string | null;
  org_department_id?: string | null;
  position_id?: string | null;
  tab_number?: string | null;
  profile?: IHrProfileInput;
}

export interface IDraftRow {
  id: string;
  created_by: string;
  state: DraftState;

  attach_error: string | null;
  payload_enc: string | null;
  employee_id: number | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export interface IDraftView {
  id: string;
  state: DraftState;
  employee_id: number | null;
  attach_error: string | null;
  expires_at: string;
  /** Нужно мастеру, чтобы показать «незавершённая анкета от ЧЧ:ММ». */
  updated_at: string;
  payload: IDraftPayload;
  documents: IHrDocumentPublic[];
  /** Слитые распознанные поля (приоритет: перевод паспорта > остальные). */
  ocr_patch: HrOcrPatch;
  ocr_sources: Record<string, string>;
}

export class HrDraftError extends Error {
  constructor(message: string, readonly status: number, readonly code: string, readonly details?: unknown) {
    super(message);
    this.name = 'HrDraftError';
  }
}

const DRAFT_TTL_HOURS = 24;

export const loadDraft = async (draftId: string, client?: PoolClient): Promise<IDraftRow | null> => {
  const sql = `SELECT * FROM employee_hr_drafts WHERE id = $1`;
  return client ? (await client.query<IDraftRow>(sql, [draftId])).rows[0] ?? null : queryOne<IDraftRow>(sql, [draftId]);
};

export const readPayload = (row: IDraftRow): IDraftPayload => decryptJson<IDraftPayload>(row.payload_enc) ?? {};

export const createDraft = async (userId: string, payload: IDraftPayload = {}): Promise<IDraftRow> => {
  const { enc, keyVersion } = encryptJson(payload);
  const row = await queryOne<IDraftRow>(
    `INSERT INTO employee_hr_drafts (created_by, payload_enc, key_version, expires_at)
     VALUES ($1, $2, $3, now() + ($4 || ' hours')::interval) RETURNING *`,
    [userId, enc, keyVersion, String(DRAFT_TTL_HOURS)],
  );
  if (!row) throw new Error('INSERT employee_hr_drafts не вернул строку');
  return row;
};

export const updateDraftPayload = async (draftId: string, patch: IDraftPayload): Promise<IDraftRow> => {
  return withTransaction(async client => {
    const res = await client.query<IDraftRow>(`SELECT * FROM employee_hr_drafts WHERE id = $1 FOR UPDATE`, [draftId]);
    const row = res.rows[0];
    if (!row) throw new HrDraftError('Черновик не найден', 404, 'not_found');
    if (row.state === 'attached') throw new HrDraftError('Черновик уже завершён', 409, 'attached');
    const current = readPayload(row);
    const next: IDraftPayload = { ...current, ...patch, profile: { ...(current.profile ?? {}), ...(patch.profile ?? {}) } };
    const { enc, keyVersion } = encryptJson(next);
    const upd = await client.query<IDraftRow>(
      `UPDATE employee_hr_drafts SET payload_enc = $2, key_version = $3, updated_at = now() WHERE id = $1 RETURNING *`,
      [draftId, enc, keyVersion],
    );
    return upd.rows[0];
  });
};

/** Тип паспорта из payload черновика (для маршрутизации OCR документа черновика). */
export const resolveDraftPassportTypeForDocument = async (documentId: number): Promise<'russian' | 'foreign' | null> => {
  const link = await queryOne<{ entity_id: string }>(
    `SELECT entity_id FROM document_links WHERE document_id = $1 AND entity_type = 'hr_draft' LIMIT 1`,
    [documentId],
  );
  if (!link) return null;
  const draft = await loadDraft(link.entity_id);
  if (!draft) return null;
  const payload = readPayload(draft);
  if (payload.profile?.passport_type) return payload.profile.passport_type;
  // Иностранец без явного типа паспорта: по гражданству (не РФ → foreign).
  if (payload.profile?.citizenship_id) {
    const cit = (await listCitizenships()).find(c => c.id === payload.profile?.citizenship_id);
    if (cit) return cit.iso_code === 'RUS' ? 'russian' : 'foreign';
  }
  return null;
};

const OCR_PRIORITY: Record<string, number> = {
  passport_translation: 100,
  passport_rf: 90,
  foreign_passport: 80,
  kig_back: 60,
  kig: 50,
  patent: 40,
  inn: 30,
  snils: 30,
  bank_details: 20,
  insurance_policy: 10,
  visa: 10,
  registration_amina: 10,
};

/** Слить распознанные поля всех документов черновика: сначала низкий приоритет, сверху — высокий. */
export const mergeDraftOcr = async (draftId: string): Promise<{ patch: HrOcrPatch; sources: Record<string, string>; documents: IHrDocumentPublic[] }> => {
  const rows = await listDraftHrDocumentRows(draftId);
  const citizenships = await listCitizenships();
  const ordered = rows
    .map(row => ({ row, result: readRecognitionResult(row) as (ReturnType<typeof readRecognitionResult> & { type?: HrOcrType; normalized?: unknown; qualityGate?: string }) | null }))
    .filter(x => x.result && x.row.recognition_status === 'done')
    .sort((a, b) => (OCR_PRIORITY[String(a.result?.type)] ?? 0) - (OCR_PRIORITY[String(b.result?.type)] ?? 0));
  const patch: HrOcrPatch = {};
  const sources: Record<string, string> = {};
  for (const { row, result } of ordered) {
    const normalized = (result as { normalized?: unknown } | null)?.normalized;
    if (!normalized || typeof normalized !== 'object') continue;
    const type = String((result as { type?: string }).type ?? '');
    const docPatch = buildProfilePatchFromOcr(normalized as Parameters<typeof buildProfilePatchFromOcr>[0], citizenships);
    for (const [field, value] of Object.entries(docPatch)) {
      // ФИО — только из перевода или паспорта РФ (иностранный паспорт/КИГ ФИО не дают по промпту, но подстрахуемся).
      if (['last_name', 'first_name', 'middle_name'].includes(field) && !['passport_translation', 'passport_rf', 'inn', 'snils', 'patent', 'kig_back'].includes(type)) continue;
      patch[field] = value;
      sources[field] = getHrDocumentType(row.category)?.code ?? row.category;
    }
  }
  return { patch, sources, documents: rows.map(toPublic) };
};

export const buildDraftView = async (row: IDraftRow): Promise<IDraftView> => {
  const merged = await mergeDraftOcr(row.id);
  return {
    id: row.id,
    state: row.state,
    employee_id: row.employee_id,
    attach_error: row.attach_error,
    expires_at: row.expires_at,
    updated_at: row.updated_at,
    payload: readPayload(row),
    documents: merged.documents,
    ocr_patch: merged.patch,
    ocr_sources: merged.sources,
  };
};

/**
 * Отметить, что сотрудник по черновику создан, ДО попытки прикрепления.
 * Из этого состояния повторное создание невозможно — только повтор attach.
 */
export const markEmployeeCreated = async (draftId: string, employeeId: number, actor: IHrActor): Promise<void> => {
  const row = await loadDraft(draftId);
  if (!row) throw new HrDraftError('Черновик не найден', 404, 'not_found');
  if (row.created_by !== actor.userId) throw new HrDraftError('Чужой черновик', 403, 'forbidden');
  if (row.employee_id && row.employee_id !== employeeId) {
    throw new HrDraftError(`Черновик уже привязан к сотруднику #${row.employee_id}`, 409, 'already_linked');
  }
  await execute(
    `UPDATE employee_hr_drafts
        SET employee_id = $2,
            state = CASE WHEN state = 'attached' THEN 'attached' ELSE 'employee_created_pending_attach' END,
            updated_at = now()
      WHERE id = $1`,
    [draftId, employeeId],
  );
};

/**
 * Прикрепить черновик (профиль + сканы) к сотруднику. Идемпотентно: повторный
 * вызов не дублирует документы и не плодит профиль. При ошибке черновик остаётся
 * в employee_created_pending_attach с заполненным attach_error.
 */
export const attachDraftToEmployee = async (draftId: string, employeeId: number, actor: IHrActor): Promise<{ autoFilled: string[]; conflicts: string[] }> => {
  const row = await loadDraft(draftId);
  if (!row) throw new HrDraftError('Черновик не найден', 404, 'not_found');
  if (row.created_by !== actor.userId) throw new HrDraftError('Чужой черновик', 403, 'forbidden');
  if (row.employee_id && row.employee_id !== employeeId) {
    throw new HrDraftError(`Черновик уже привязан к сотруднику #${row.employee_id}`, 409, 'already_linked');
  }
  const payload = readPayload(row);
  const emp = await queryOne<{ id: number }>(`SELECT id FROM employees WHERE id = $1`, [employeeId]);
  if (!emp) throw new HrDraftError('Сотрудник не найден', 404, 'employee_not_found');

  let outcome: { autoFilled: string[]; conflicts: string[] };
  try {
    outcome = await withTransaction(async client => {
      await createProfile(employeeId, {}, actor, 'wizard', { client });
      const current = await loadProfileRow(employeeId, client);
      const plain = current ? rowToPlainFields(current) : {};
      const patch = Object.fromEntries(Object.entries(payload.profile ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== '')) as HrOcrPatch;
      const plan = buildOcrApplyPlan(plain as Record<string, unknown>, patch);
      let autoFilled: string[] = [];
      if (Object.keys(plan.autoFill).length > 0) {
        const res = await applyProfilePatch(client, employeeId, plan.autoFill as IHrProfileInput, actor, 'wizard', { historyEvent: 'attach_existing' });
        autoFilled = res.changedFields;
      }
      await attachDraftDocumentsToEmployee(client, draftId, employeeId);
      await client.query(
        `UPDATE employee_hr_drafts SET state = 'attached', employee_id = $2, attach_error = NULL, updated_at = now() WHERE id = $1`,
        [draftId, employeeId],
      );
      await recordHistory(client, employeeId, 'attach_existing', { changedFields: autoFilled, actor, source: 'wizard' });
      return { autoFilled, conflicts: plan.conflicts.map(c => c.fieldName) };
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Не удалось прикрепить документы';
    await execute(
      `UPDATE employee_hr_drafts SET employee_id = $2, state = 'employee_created_pending_attach', attach_error = $3, updated_at = now() WHERE id = $1`,
      [draftId, employeeId, message.slice(0, 500)],
    ).catch(() => undefined);
    throw err;
  }

  // Распознанные документы черновика → профиль (конфликты запишутся стандартным путём).
  const { loadHrDocument, listEmployeeHrDocumentRows } = await import('./hr-documents.service.js');
  for (const doc of await listEmployeeHrDocumentRows(employeeId)) {
    const full = await loadHrDocument(doc.id);
    const result = full ? (readRecognitionResult(full) as { type?: HrOcrType; normalized?: unknown } | null) : null;
    if (full && full.recognition_status === 'done' && result?.normalized && result.type && full.uploaded_by === actor.userId) {
      await applyOcrToEmployee(employeeId, full.id, result.type, result.normalized as Parameters<typeof applyOcrToEmployee>[3]).catch(() => undefined);
    }
  }
  return outcome;
};

/** Просроченные черновики → expired; сканы soft-delete (R2 чистится purge-задачей). */
export const expireDrafts = async (): Promise<number> => {
  const rows = await query<{ id: string }>(
    `UPDATE employee_hr_drafts SET state = 'expired', updated_at = now()
      WHERE state = 'draft' AND expires_at < now() RETURNING id`,
  );
  for (const r of rows) {
    await execute(
      `UPDATE documents SET deleted_at = now() WHERE deleted_at IS NULL AND id IN (SELECT document_id FROM document_links WHERE entity_type = 'hr_draft' AND entity_id = $1)`,
      [r.id],
    );
  }
  return rows.length;
};

export const listMyOpenDrafts = async (userId: string): Promise<IDraftRow[]> =>
  query<IDraftRow>(`SELECT * FROM employee_hr_drafts WHERE created_by = $1 AND state IN ('draft','employee_created_pending_attach') ORDER BY updated_at DESC LIMIT 20`, [userId]);

export const resolveOcrTypeForDraftDoc = resolveOcrType;
