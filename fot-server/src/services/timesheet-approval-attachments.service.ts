import { query, queryOne, withTransaction } from '../config/postgres.js';
import { r2Service } from './r2.service.js';
import { listApprovalEmployees } from './timesheet-approval-employees-snapshot.service.js';

export const APPROVAL_ATTACHMENT_ENTITY_TYPE = 'timesheet_approval';
export const APPROVAL_ATTACHMENT_PURPOSE = 'weekend_confirmation';
export const APPROVAL_ATTACHMENT_CATEGORY = 'timesheet_weekend_confirmation';

// Файлы корректировок (entity_type/purpose из correction-attachments.service.ts).
const CORRECTION_ATTACHMENT_ENTITY_TYPE = 'attendance_adjustment';
const CORRECTION_ATTACHMENT_PURPOSE = 'timesheet_correction';

export interface IApprovalAttachmentEmployee {
  employee_id: number;
  employee_name: string | null;
  employee_position: string | null;
}

export interface IApprovalAttachment {
  document_id: number;
  file_name: string;
  file_size: number;
  mime_type: string;
  r2_key: string;
  uploaded_by: string;
  uploaded_by_name: string | null;
  /** Должность загрузившего (резолв user_profiles.employee_id → positions). */
  uploader_position?: string | null;
  created_at: string;
  /** Основной тип вложения (по приоритету weekend_memo > correction > leave_request). */
  kind?: 'weekend_memo' | 'correction' | 'leave_request';
  /** Все источники документа (один файл может быть и корректировкой, и заявлением). */
  sources?: Array<'correction' | 'leave_request'>;
  /** Человекочитаемая причина появления: «Корректировка» | «Заявление» | «Корректировка, заявление» | «Служебка (выходные)». */
  reason_label?: string;
  /** Субъект (к кому относится файл) — первый сотрудник, для обратной совместимости. */
  employee_id?: number | null;
  employee_name?: string | null;
  employee_position?: string | null;
  /** Все сотрудники документа (при дедупе один файл теоретически относится к нескольким). */
  employees?: IApprovalAttachmentEmployee[];
  /** Первая дата (обратная совместимость) + все дни файла. */
  work_date?: string | null;
  work_dates?: string[];
  /** Файл загружен тем, кто подал табель (uploaded_by === submitted_by). НЕ «гарантированно руководитель». */
  is_submitter_file?: boolean;
  /** Подписанные URL (агрегатор отдаёт их сразу — у корректировок свой авторизационный путь). */
  download_url?: string;
  preview_url?: string;
}

export async function findOrCreateDraftApproval(params: {
  departmentId: string | null;
  managerEmployeeId: number | null;
  startDate: string;
  endDate: string;
  userId: string;
}): Promise<{ id: number; status: string }> {
  const { departmentId, managerEmployeeId, startDate, endDate } = params;

  if ((departmentId == null) === (managerEmployeeId == null)) {
    throw new Error('findOrCreateDraftApproval: ровно одно из departmentId/managerEmployeeId должно быть указано');
  }

  const existing = managerEmployeeId != null
    ? await queryOne<{ id: number | string; status: string }>(
        `SELECT id, status FROM timesheet_approvals
           WHERE manager_employee_id = $1 AND start_date = $2 AND end_date = $3
           LIMIT 1`,
        [managerEmployeeId, startDate, endDate],
      )
    : await queryOne<{ id: number | string; status: string }>(
        `SELECT id, status FROM timesheet_approvals
           WHERE department_id = $1 AND start_date = $2 AND end_date = $3
             AND manager_employee_id IS NULL
           LIMIT 1`,
        [departmentId, startDate, endDate],
      );

  if (existing) {
    return { id: Number(existing.id), status: String(existing.status) };
  }

  const now = new Date().toISOString();
  const inserted = await queryOne<{ id: number | string; status: string }>(
    `INSERT INTO timesheet_approvals (department_id, manager_employee_id, start_date, end_date, status, updated_at)
       VALUES ($1, $2, $3, $4, 'draft', $5)
       RETURNING id, status`,
    [departmentId, managerEmployeeId, startDate, endDate, now],
  );
  if (!inserted) {
    throw new Error('Failed to create draft approval');
  }
  return { id: Number(inserted.id), status: String(inserted.status) };
}

export async function listApprovalAttachments(approvalId: number): Promise<IApprovalAttachment[]> {
  const links = await query<{ document_id: number | string }>(
    `SELECT document_id FROM document_links
       WHERE entity_type = $1 AND entity_id = $2 AND purpose = $3`,
    [APPROVAL_ATTACHMENT_ENTITY_TYPE, String(approvalId), APPROVAL_ATTACHMENT_PURPOSE],
  );
  const docIds = links.map(row => Number(row.document_id));
  if (docIds.length === 0) return [];

  const docs = await query<{
    id: number | string;
    file_name: string;
    file_size: number | string;
    mime_type: string;
    r2_key: string;
    uploaded_by: string;
    created_at: string;
  }>(
    `SELECT id, file_name, file_size, mime_type, r2_key, uploaded_by, created_at
       FROM documents
       WHERE id = ANY($1::int[])
       ORDER BY created_at DESC`,
    [docIds],
  );

  const uploaderIds = [...new Set(docs.map(row => String(row.uploaded_by)).filter(Boolean))];
  const names = new Map<string, string | null>();
  if (uploaderIds.length > 0) {
    const profiles = await query<{ id: string; full_name: string | null }>(
      `SELECT id, full_name FROM user_profiles WHERE id = ANY($1::uuid[])`,
      [uploaderIds],
    );
    for (const row of profiles) {
      names.set(String(row.id), row.full_name ?? null);
    }
  }

  return docs.map(row => ({
    document_id: Number(row.id),
    file_name: String(row.file_name),
    file_size: Number(row.file_size),
    mime_type: String(row.mime_type),
    r2_key: String(row.r2_key),
    uploaded_by: String(row.uploaded_by),
    uploaded_by_name: names.get(String(row.uploaded_by)) ?? null,
    created_at: String(row.created_at),
  }));
}

/**
 * Единый список вложений периода подачи для ВСЕХ ролей (одинаковый набор):
 *   - служебка о выходных (weekend-memo, привязка к approval);
 *   - файлы корректировок (attendance_adjustment / timesheet_correction);
 *   - файлы заявлений (leave_request: по source_id корректировки + time_correction-заявки дня;
 *     document_links entity_type='leave_request' + legacy documents.leave_request_id).
 * Всё batch-запросами (число запросов фиксировано, не зависит от кол-ва дней/сотрудников).
 * Дедуп по document_id с сохранением всех дат/сотрудников/источников. Отдаёт подписанные
 * URL прямо в ответе — у файлов корректировок/заявлений свой авторизационный путь,
 * отдельный getAttachmentDownloadUrl на них не работает.
 */
export async function listApprovalPeriodAttachments(approvalId: number): Promise<IApprovalAttachment[]> {
  const r2Enabled = await r2Service.isEnabledAsync();
  const signUrls = async (item: IApprovalAttachment): Promise<IApprovalAttachment> => {
    if (!r2Enabled) return item;
    return {
      ...item,
      download_url: await r2Service.generateDownloadUrl(item.r2_key, item.file_name),
      preview_url: await r2Service.generateDownloadUrl(item.r2_key, item.file_name, 'inline'),
    };
  };

  const approval = await queryOne<{ start_date: string; end_date: string; submitted_by: string | null }>(
    `SELECT start_date, end_date, submitted_by FROM timesheet_approvals WHERE id = $1 LIMIT 1`,
    [approvalId],
  );
  const submittedBy = approval?.submitted_by ? String(approval.submitted_by) : null;
  const startDate = approval?.start_date;
  const endDate = approval?.end_date;

  // --- 1. Служебки о выходных (привязка к approval; без подписи URL — подпишем в конце). ---
  const weekendDocs = await listApprovalAttachments(approvalId);

  // --- 2. Снимок состава + корректировки периода. ---
  const snapshot = approval ? await listApprovalEmployees(approvalId) : [];
  const employeeIds = snapshot.map(s => Number(s.employee_id)).filter(id => Number.isInteger(id) && id > 0);
  const nameById = new Map<number, string | null>(snapshot.map(s => [Number(s.employee_id), s.full_name ?? null] as const));

  type AdjRow = { id: number; employee_id: number; work_date: string; source_type: string | null; source_id: string | null };
  let adjustments: AdjRow[] = [];
  if (approval && employeeIds.length > 0) {
    const rows = await query<{ id: number | string; employee_id: number | string; work_date: string; source_type: string | null; source_id: string | null }>(
      `SELECT id, employee_id, work_date, source_type, source_id
         FROM attendance_adjustments
        WHERE employee_id = ANY($1::int[]) AND work_date >= $2 AND work_date <= $3`,
      [employeeIds, startDate, endDate],
    );
    adjustments = rows.map(r => ({
      id: Number(r.id),
      employee_id: Number(r.employee_id),
      work_date: String(r.work_date),
      source_type: r.source_type ? String(r.source_type) : null,
      source_id: r.source_id ? String(r.source_id) : null,
    }));
  }

  // docId -> агрегат метаданных корректировок/заявлений (дедуп с сохранением источников/дат/сотрудников).
  const docAgg = new Map<number, { sources: Set<'correction' | 'leave_request'>; dates: Set<string>; employeeIds: Set<number> }>();
  const ensureAgg = (docId: number) => {
    let agg = docAgg.get(docId);
    if (!agg) { agg = { sources: new Set(), dates: new Set(), employeeIds: new Set() }; docAgg.set(docId, agg); }
    return agg;
  };

  if (adjustments.length > 0) {
    const adjById = new Map<number, { employee_id: number; work_date: string }>();
    for (const a of adjustments) adjById.set(a.id, { employee_id: a.employee_id, work_date: a.work_date });

    // --- 3. Собственные файлы корректировок (own). ---
    const ownLinks = await query<{ entity_id: string; document_id: number | string }>(
      `SELECT entity_id, document_id FROM document_links
        WHERE entity_type = $1 AND purpose = $2 AND entity_id = ANY($3::text[])`,
      [CORRECTION_ATTACHMENT_ENTITY_TYPE, CORRECTION_ATTACHMENT_PURPOSE, adjustments.map(a => String(a.id))],
    );
    for (const link of ownLinks) {
      const adj = adjById.get(Number(link.entity_id));
      if (!adj) continue;
      const agg = ensureAgg(Number(link.document_id));
      agg.sources.add('correction');
      agg.dates.add(adj.work_date);
      agg.employeeIds.add(adj.employee_id);
    }

    // --- 4. Кандидаты-заявки: source_id корректировки + time_correction-заявки дня. ---
    // leaveId -> контексты (employee_id, work_date), в которых заявка фигурирует.
    const leaveContexts = new Map<number, Array<{ employee_id: number; work_date: string }>>();
    const addLeaveContext = (leaveId: number, ctx: { employee_id: number; work_date: string }) => {
      const arr = leaveContexts.get(leaveId) ?? [];
      arr.push(ctx);
      leaveContexts.set(leaveId, arr);
    };
    for (const a of adjustments) {
      if (a.source_type === 'leave_request' && a.source_id) {
        const id = Number(a.source_id.split(':', 1)[0]);
        if (Number.isFinite(id) && id > 0) addLeaveContext(id, { employee_id: a.employee_id, work_date: a.work_date });
      }
    }
    // time_correction-заявки периода (служебка о работе в выходной): (employee_id|дата) -> leaveId(s).
    const tcRows = await query<{ id: number | string; employee_id: number | string; d: string }>(
      `SELECT id, employee_id, COALESCE(correction_date, start_date)::text AS d
         FROM leave_requests
        WHERE employee_id = ANY($1::int[])
          AND request_type = 'time_correction'
          AND status <> 'rejected'
          AND COALESCE(correction_date, start_date) >= $2::date
          AND COALESCE(correction_date, start_date) <= $3::date`,
      [employeeIds, startDate, endDate],
    );
    const tcByKey = new Map<string, number[]>();
    for (const r of tcRows) {
      const key = `${Number(r.employee_id)}|${String(r.d)}`;
      const arr = tcByKey.get(key) ?? [];
      arr.push(Number(r.id));
      tcByKey.set(key, arr);
    }
    for (const a of adjustments) {
      const ids = tcByKey.get(`${a.employee_id}|${a.work_date}`);
      if (ids) for (const id of ids) addLeaveContext(id, { employee_id: a.employee_id, work_date: a.work_date });
    }

    // --- 5. doc-id заявок (document_links entity_type='leave_request' + legacy documents.leave_request_id). ---
    const leaveIds = [...leaveContexts.keys()];
    if (leaveIds.length > 0) {
      const leaveDocIds = new Map<number, Set<number>>();
      const addLeaveDoc = (leaveId: number, docId: number) => {
        const set = leaveDocIds.get(leaveId) ?? new Set<number>();
        set.add(docId);
        leaveDocIds.set(leaveId, set);
      };
      const lrLinks = await query<{ entity_id: string; document_id: number | string }>(
        `SELECT entity_id, document_id FROM document_links
          WHERE entity_type = 'leave_request' AND entity_id = ANY($1::text[])`,
        [leaveIds.map(String)],
      );
      for (const l of lrLinks) addLeaveDoc(Number(l.entity_id), Number(l.document_id));
      const legacy = await query<{ id: number | string; leave_request_id: number | string }>(
        `SELECT id, leave_request_id FROM documents WHERE leave_request_id = ANY($1::int[])`,
        [leaveIds],
      );
      for (const l of legacy) addLeaveDoc(Number(l.leave_request_id), Number(l.id));

      for (const [leaveId, set] of leaveDocIds) {
        const ctxs = leaveContexts.get(leaveId) ?? [];
        for (const docId of set) {
          const agg = ensureAgg(docId);
          agg.sources.add('leave_request');
          for (const ctx of ctxs) { agg.dates.add(ctx.work_date); agg.employeeIds.add(ctx.employee_id); }
        }
      }
    }
  }

  // Нет ни служебок, ни файлов корректировок/заявлений — пустой ответ.
  if (weekendDocs.length === 0 && docAgg.size === 0) return [];

  // --- 6. Документы корректировок/заявлений. ---
  const corrDocIds = [...docAgg.keys()];
  type DocRow = { id: number; file_name: string; file_size: number; mime_type: string; r2_key: string; uploaded_by: string | null; created_at: string };
  const docsById = new Map<number, DocRow>();
  if (corrDocIds.length > 0) {
    const docs = await query<{ id: number | string; file_name: string; file_size: number | string; mime_type: string; r2_key: string; uploaded_by: string | null; created_at: string }>(
      `SELECT id, file_name, file_size, mime_type, r2_key, uploaded_by, created_at
         FROM documents WHERE id = ANY($1::int[])`,
      [corrDocIds],
    );
    for (const d of docs) {
      docsById.set(Number(d.id), {
        id: Number(d.id), file_name: String(d.file_name), file_size: Number(d.file_size),
        mime_type: String(d.mime_type), r2_key: String(d.r2_key),
        uploaded_by: d.uploaded_by ? String(d.uploaded_by) : null, created_at: String(d.created_at),
      });
    }
  }

  // --- 7+8. Профили загрузивших (имя + employee_id) и должности (субъекты ∪ загрузившие). ---
  const subjectEmployeeIds = new Set<number>();
  for (const agg of docAgg.values()) for (const id of agg.employeeIds) subjectEmployeeIds.add(id);

  const uploaderIds = new Set<string>();
  for (const w of weekendDocs) if (w.uploaded_by) uploaderIds.add(String(w.uploaded_by));
  for (const d of docsById.values()) if (d.uploaded_by) uploaderIds.add(d.uploaded_by);

  const uploaderName = new Map<string, string | null>();
  const uploaderEmpId = new Map<string, number | null>();
  if (uploaderIds.size > 0) {
    const profiles = await query<{ id: string; full_name: string | null; employee_id: number | string | null }>(
      `SELECT id, full_name, employee_id FROM user_profiles WHERE id = ANY($1::uuid[])`,
      [[...uploaderIds]],
    );
    for (const p of profiles) {
      uploaderName.set(String(p.id), p.full_name ?? null);
      uploaderEmpId.set(String(p.id), p.employee_id != null ? Number(p.employee_id) : null);
    }
  }

  const positionEmpIds = new Set<number>(subjectEmployeeIds);
  for (const empId of uploaderEmpId.values()) if (empId != null) positionEmpIds.add(empId);
  const positionByEmp = new Map<number, string | null>();
  if (positionEmpIds.size > 0) {
    const empRows = await query<{ id: number | string; position_id: number | string | null }>(
      `SELECT id, position_id FROM employees WHERE id = ANY($1::int[])`,
      [[...positionEmpIds]],
    );
    const empToPos = new Map<number, string | null>();
    const posIds = new Set<string>();
    for (const e of empRows) {
      const pid = e.position_id != null ? String(e.position_id) : null;
      empToPos.set(Number(e.id), pid);
      if (pid) posIds.add(pid);
    }
    const posName = new Map<string, string | null>();
    if (posIds.size > 0) {
      const posRows = await query<{ id: string | number; name: string | null }>(
        `SELECT id, name FROM positions WHERE id::text = ANY($1::text[])`,
        [[...posIds]],
      );
      for (const p of posRows) posName.set(String(p.id), p.name ?? null);
    }
    for (const [empId, pid] of empToPos) positionByEmp.set(empId, pid ? posName.get(pid) ?? null : null);
  }
  const uploaderPosition = (uploaderId: string | null): string | null => {
    if (!uploaderId) return null;
    const empId = uploaderEmpId.get(uploaderId);
    return empId != null ? positionByEmp.get(empId) ?? null : null;
  };

  const composeReason = (sources: Set<'correction' | 'leave_request'>): string => {
    const hasC = sources.has('correction');
    const hasL = sources.has('leave_request');
    if (hasC && hasL) return 'Корректировка, заявление';
    if (hasL) return 'Заявление';
    return 'Корректировка';
  };

  // --- Сборка. ---
  const weekendItems: IApprovalAttachment[] = weekendDocs.map(doc => ({
    ...doc,
    uploader_position: uploaderPosition(doc.uploaded_by ? String(doc.uploaded_by) : null),
    kind: 'weekend_memo',
    sources: [],
    reason_label: 'Служебка (выходные)',
    employee_id: null,
    employee_name: null,
    employee_position: null,
    employees: [],
    work_date: null,
    work_dates: [],
    is_submitter_file: Boolean(submittedBy && doc.uploaded_by && String(doc.uploaded_by) === submittedBy),
  }));

  const corrItems: IApprovalAttachment[] = [];
  for (const [docId, agg] of docAgg) {
    const doc = docsById.get(docId);
    if (!doc) continue;
    const dates = [...agg.dates].sort();
    const employees: IApprovalAttachmentEmployee[] = [...agg.employeeIds]
      .map(id => ({ employee_id: id, employee_name: nameById.get(id) ?? null, employee_position: positionByEmp.get(id) ?? null }))
      .sort((a, b) => String(a.employee_name ?? '').localeCompare(String(b.employee_name ?? '')));
    const first = employees[0] ?? null;
    corrItems.push({
      document_id: doc.id,
      file_name: doc.file_name,
      file_size: doc.file_size,
      mime_type: doc.mime_type,
      r2_key: doc.r2_key,
      uploaded_by: doc.uploaded_by ?? '',
      uploaded_by_name: doc.uploaded_by ? uploaderName.get(doc.uploaded_by) ?? null : null,
      uploader_position: uploaderPosition(doc.uploaded_by),
      created_at: doc.created_at,
      kind: agg.sources.has('correction') ? 'correction' : 'leave_request',
      sources: [...agg.sources],
      reason_label: composeReason(agg.sources),
      employee_id: first?.employee_id ?? null,
      employee_name: first?.employee_name ?? null,
      employee_position: first?.employee_position ?? null,
      employees,
      work_date: dates[0] ?? null,
      work_dates: dates,
      is_submitter_file: Boolean(submittedBy && doc.uploaded_by && doc.uploaded_by === submittedBy),
    });
  }

  // Сортировка: файлы подавшего табель — первыми; внутри — служебки, затем по ФИО и дате.
  const all = [...weekendItems, ...corrItems];
  all.sort((a, b) => {
    if (a.is_submitter_file !== b.is_submitter_file) return a.is_submitter_file ? -1 : 1;
    const aMemo = a.kind === 'weekend_memo' ? 0 : 1;
    const bMemo = b.kind === 'weekend_memo' ? 0 : 1;
    if (aMemo !== bMemo) return aMemo - bMemo;
    const n = String(a.employee_name ?? '').localeCompare(String(b.employee_name ?? ''));
    if (n !== 0) return n;
    return String(a.work_date ?? '').localeCompare(String(b.work_date ?? ''));
  });

  return Promise.all(all.map(signUrls));
}

export async function countApprovalAttachments(approvalId: number): Promise<number> {
  const row = await queryOne<{ count: number | string }>(
    `SELECT COUNT(*)::int AS count FROM document_links
       WHERE entity_type = $1 AND entity_id = $2 AND purpose = $3`,
    [APPROVAL_ATTACHMENT_ENTITY_TYPE, String(approvalId), APPROVAL_ATTACHMENT_PURPOSE],
  );
  return row ? Number(row.count) : 0;
}

/**
 * Количество служебок, привязанных к любой из строк подачи (entity_id хранится как text).
 * При сабмите файл мог быть загружен на точный черновик диапазона, а консолидируется
 * на другую пересекающуюся строку — считаем по всем кандидатам.
 */
export async function countApprovalAttachmentsForApprovals(approvalIds: number[]): Promise<number> {
  const ids = [...new Set(approvalIds)].filter(id => Number.isInteger(id) && id > 0).map(String);
  if (ids.length === 0) return 0;
  const row = await queryOne<{ count: number | string }>(
    `SELECT COUNT(*)::int AS count FROM document_links
       WHERE entity_type = $1 AND purpose = $2 AND entity_id = ANY($3::text[])`,
    [APPROVAL_ATTACHMENT_ENTITY_TYPE, APPROVAL_ATTACHMENT_PURPOSE, ids],
  );
  return row ? Number(row.count) : 0;
}

/**
 * Перевешивает ссылки на служебки с вытесняемых строк подачи на выжившую.
 * Вызывается ВНУТРИ транзакции сабмита перед удалением toDeleteIds, иначе
 * document_links осиротеют и файл потеряется. Работает на переданном client.
 */
export async function relinkApprovalAttachments(
  client: { query: (sql: string, params: unknown[]) => Promise<unknown> },
  fromApprovalIds: number[],
  toApprovalId: number,
): Promise<void> {
  const fromIds = [...new Set(fromApprovalIds)]
    .filter(id => Number.isInteger(id) && id > 0 && id !== toApprovalId)
    .map(String);
  if (fromIds.length === 0) return;
  await client.query(
    `UPDATE document_links
        SET entity_id = $1
      WHERE entity_type = $2 AND purpose = $3 AND entity_id = ANY($4::text[])`,
    [String(toApprovalId), APPROVAL_ATTACHMENT_ENTITY_TYPE, APPROVAL_ATTACHMENT_PURPOSE, fromIds],
  );
}

export async function createAttachmentRecord(params: {
  approvalId: number;
  fileName: string;
  fileSize: number;
  mimeType: string;
  r2Key: string;
  uploadedBy: string;
}): Promise<IApprovalAttachment> {
  return withTransaction(async (client) => {
    const docResult = await client.query<{
      id: number | string;
      file_name: string;
      file_size: number | string;
      mime_type: string;
      r2_key: string;
      uploaded_by: string;
      created_at: string;
    }>(
      `INSERT INTO documents (employee_id, leave_request_id, category, file_name, file_size, mime_type, r2_key, uploaded_by)
         VALUES (NULL, NULL, $1, $2, $3, $4, $5, $6)
         RETURNING id, file_name, file_size, mime_type, r2_key, uploaded_by, created_at`,
      [
        APPROVAL_ATTACHMENT_CATEGORY,
        params.fileName,
        params.fileSize,
        params.mimeType,
        params.r2Key,
        params.uploadedBy,
      ],
    );
    const doc = docResult.rows[0];
    if (!doc) {
      throw new Error('Failed to insert document');
    }

    await client.query(
      `INSERT INTO document_links (document_id, entity_type, entity_id, purpose)
         VALUES ($1, $2, $3, $4)`,
      [doc.id, APPROVAL_ATTACHMENT_ENTITY_TYPE, String(params.approvalId), APPROVAL_ATTACHMENT_PURPOSE],
    );

    return {
      document_id: Number(doc.id),
      file_name: String(doc.file_name),
      file_size: Number(doc.file_size),
      mime_type: String(doc.mime_type),
      r2_key: String(doc.r2_key),
      uploaded_by: String(doc.uploaded_by),
      uploaded_by_name: null,
      created_at: String(doc.created_at),
    };
  });
}

export async function deleteAttachmentRecord(documentId: number): Promise<{ deleted: boolean; r2Key: string | null; approvalId: number | null }> {
  const link = await queryOne<{ entity_id: string }>(
    `SELECT entity_id FROM document_links
       WHERE document_id = $1 AND entity_type = $2 AND purpose = $3
       LIMIT 1`,
    [documentId, APPROVAL_ATTACHMENT_ENTITY_TYPE, APPROVAL_ATTACHMENT_PURPOSE],
  );
  const approvalId = link ? Number(link.entity_id) : null;

  const doc = await queryOne<{ r2_key: string }>(
    `SELECT r2_key FROM documents WHERE id = $1 LIMIT 1`,
    [documentId],
  );
  const r2Key = doc ? String(doc.r2_key) : null;

  await withTransaction(async (client) => {
    await client.query(`DELETE FROM document_links WHERE document_id = $1`, [documentId]);
    await client.query(`DELETE FROM documents WHERE id = $1`, [documentId]);
  });

  if (r2Key) {
    try {
      await r2Service.deleteObject(r2Key);
    } catch (err) {
      console.warn('timesheet-approval-attachments.delete: r2 delete failed', err);
    }
  }

  return { deleted: Boolean(doc), r2Key, approvalId };
}
