/**
 * Кадровые профили («Реквизиты»): каталог, список с фильтрами, карточка с
 * маскированием, правка, история, антидубль, ЗУП, конфликты OCR.
 * Право: /staff-control/hr-profiles (view/edit), скоуп по сотрудникам.
 */
import type { Response } from 'express';
import { z } from 'zod';
import { query, queryOne, withTransaction } from '../config/postgres.js';
import type { AuthenticatedRequest } from '../types/index.js';
import {
  canAccessEmployeeInScope,
  resolveAccessibleDepartmentIds,
  resolveAccessibleEmployeeIds,
} from '../services/data-scope.service.js';
import { resolveEffectivePageAccess } from '../services/access-control.service.js';
import { auditService } from '../services/audit.service.js';
import { escapeLike } from '../utils/search.utils.js';
import {
  HR_DOCUMENT_PROFILES,
  HR_DOCUMENT_TYPES,
  HR_FIELD_GROUPS,
  HR_PROFILE_FIELDS,
  HR_REQUIRED_DOCUMENTS,
  RESIDENCE_PERMIT_EXCLUDED_DOCUMENTS,
  ZUP_RELEVANT_FIELDS,
  PAGE_KEY_HR_PROFILES,
  requiresPatent,
  resolveDocumentProfile,
  resolveDocumentSlots,
  getHrDocumentType,
} from '../config/hr-documents.js';
import { decryptFieldSafe, hashForSearch, isHrCryptoConfigured, maskValue, normalizeDigits, normalizeDocNumber } from '../services/hr-crypto.service.js';
import {
  IdentityClaimConflictError,
  applyProfilePatch,
  buildProfileView,
  createProfile,
  findDuplicates,
  listCitizenships,
  listHistory,
  loadProfileRow,
  markZupExported,
  recordHistory,
  rowToPlainFields,
  setZupUploaded,
  updateProfile,
  type IHrProfileInput,
} from '../services/hr-profile.service.js';
import { buildZupFileName, buildZupWorkbook, loadRowsForExport } from '../services/hr-zup-export.service.js';
import { isHrProfilesEnabled } from '../services/hr-feature-flag.service.js';
import { hrProfileInputSchema } from './hr-profiles.schema.js';

const ensureConfigured = (res: Response): boolean => {
  if (!isHrCryptoConfigured()) {
    res.status(503).json({ success: false, error: 'Кадровый модуль не настроен (ключи шифрования)', code: 'HR_NOT_CONFIGURED' });
    return false;
  }
  return true;
};

const canEdit = (req: AuthenticatedRequest): Promise<boolean> => resolveEffectivePageAccess(req, PAGE_KEY_HR_PROFILES, 'edit');

const fail = (res: Response, err: unknown, fallback: string): void => {
  if (err instanceof z.ZodError) {
    res.status(400).json({ success: false, error: err.errors[0]?.message ?? 'Некорректные данные' });
    return;
  }
  if (err instanceof IdentityClaimConflictError) {
    res.status(409).json({ success: false, error: err.message, code: 'duplicate', details: { claim_type: err.claimType, employee_id: err.employeeId } });
    return;
  }
  console.error(`[hr-profiles] ${fallback}:`, err instanceof Error ? err.message : err);
  res.status(500).json({ success: false, error: fallback });
};

const parseEmployeeId = (raw: string): number | null => {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
};

// ─── Каталог / отделы ───────────────────────────────────────────────────────

const catalog = async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const citizenships = (await listCitizenships()).filter(c => c.is_active);
    res.json({
      success: true,
      data: {
        configured: isHrCryptoConfigured(),
        enabled: await isHrProfilesEnabled(),
        document_types: HR_DOCUMENT_TYPES.map(t => ({ code: t.code, label: t.label, ocr_supported: !!t.ocrType, sort_order: t.sortOrder })),
        profiles: HR_DOCUMENT_PROFILES,
        required_documents: HR_REQUIRED_DOCUMENTS,
        residence_permit_excluded: RESIDENCE_PERMIT_EXCLUDED_DOCUMENTS,
        fields: HR_PROFILE_FIELDS,
        field_groups: HR_FIELD_GROUPS,
        zup_relevant_fields: ZUP_RELEVANT_FIELDS,
        citizenships: citizenships.map(c => ({ id: c.id, name: c.name, iso_code: c.iso_code, requires_patent: c.requires_patent, is_eaeu: c.is_eaeu })),
      },
    });
  } catch (err) {
    fail(res, err, 'Ошибка получения каталога');
  }
};

/** Отделы, в которых пользователь может создавать сотрудников (сервер — источник истины). */
const departments = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const accessible = await resolveAccessibleDepartmentIds(req);
    const where = accessible === 'all' ? '' : 'AND d.id = ANY($1::uuid[])';
    const params = accessible === 'all' ? [] : [accessible];
    const rows = await query<{ id: string; name: string; parent_id: string | null; kind: string | null; sigur_department_id: number | null }>(
      `SELECT d.id, d.name, d.parent_id, d.kind, d.sigur_department_id
         FROM org_departments d
        WHERE d.is_active = true AND d.sigur_department_id IS NOT NULL
          AND lower(d.name) <> 'уволенные' ${where}
        ORDER BY d.sort_order NULLS LAST, d.name`,
      params,
    );
    const positions = await query<{ id: string; name: string }>(
      `SELECT id, name FROM positions WHERE sigur_position_id IS NOT NULL ORDER BY name`,
    );
    res.json({ success: true, data: { departments: rows, positions } });
  } catch (err) {
    fail(res, err, 'Ошибка получения отделов');
  }
};

// ─── Список ─────────────────────────────────────────────────────────────────

interface IListRow {
  employee_id: number;
  full_name: string;
  employment_status: string;
  hire_date: string | null;
  birth_date: string | null;
  org_department_id: string | null;
  department_name: string | null;
  citizenship_id: string | null;
  citizenship_name: string | null;
  requires_patent: boolean | null;
  is_eaeu: boolean | null;
  iso_code: string | null;
  has_residence_permit: boolean;
  zup_is_uploaded: boolean;
  zup_uploaded_at: string | null;
  zup_exported_at: string | null;
  planned_exit_date: string | null;
  updated_at: string;
  file_categories: string[] | null;
  files_count: number;
  open_conflicts: number;
  ocr_pending: number;
}

const list = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!ensureConfigured(res)) return;
    const q = req.query;
    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(q.pageSize) || 50));
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (v: unknown): number => { params.push(v); return params.length; };

    const scope = await resolveAccessibleEmployeeIds(req);
    if (scope !== 'all') {
      if (scope.size === 0) {
        res.json({ success: true, data: [], meta: { total: 0, page, pageSize } });
        return;
      }
      where.push(`p.employee_id = ANY($${add([...scope])}::int[])`);
    }
    const status = typeof q.status === 'string' ? q.status : 'active';
    if (status === 'active') where.push(`e.employment_status = 'active' AND e.is_archived = false`);
    else if (status === 'fired') where.push(`e.employment_status = 'fired'`);

    if (typeof q.department_id === 'string' && q.department_id) {
      where.push(`e.org_department_id IN (SELECT id FROM public.get_descendant_department_ids($${add([q.department_id])}::uuid[]))`);
    }
    if (typeof q.citizenship_id === 'string' && q.citizenship_id) where.push(`p.citizenship_id = $${add(q.citizenship_id)}`);
    if (q.patent === 'required') where.push(`(NOT p.has_residence_permit AND c.requires_patent AND NOT c.is_eaeu)`);
    else if (q.patent === 'not_required') where.push(`NOT (NOT p.has_residence_permit AND COALESCE(c.requires_patent, false) AND NOT COALESCE(c.is_eaeu, false))`);
    if (q.zup === 'yes') where.push(`p.zup_is_uploaded = true`);
    else if (q.zup === 'no') where.push(`p.zup_is_uploaded = false`);
    if (typeof q.zupFrom === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(q.zupFrom)) where.push(`p.zup_uploaded_at::date >= $${add(q.zupFrom)}::date`);
    if (typeof q.zupTo === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(q.zupTo)) where.push(`p.zup_uploaded_at::date <= $${add(q.zupTo)}::date`);

    const search = typeof q.search === 'string' ? q.search.trim() : '';
    if (search) {
      const ors: string[] = [`e.full_name ILIKE $${add(`%${escapeLike(search)}%`)}`];
      const digits = normalizeDigits(search, 12);
      if (digits && digits.length === 11) ors.push(`p.snils_hash = $${add(hashForSearch('snils', digits))}`, `regexp_replace(COALESCE(e.pension_number,''), '\\D', '', 'g') = $${add(digits)}`);
      if (digits && (digits.length === 10 || digits.length === 12)) ors.push(`p.inn_hash = $${add(hashForSearch('inn', digits))}`);
      const doc = normalizeDocNumber(search);
      if (doc && doc.length >= 6) ors.push(`p.passport_number_hash = $${add(hashForSearch('passport', doc))}`);
      where.push(`(${ors.join(' OR ')})`);
    }

    const rows = await query<IListRow>(
      `SELECT p.employee_id, e.full_name, e.employment_status, e.hire_date, e.birth_date, e.org_department_id,
              d.name AS department_name, p.citizenship_id, c.name AS citizenship_name, c.requires_patent, c.is_eaeu, c.iso_code,
              p.has_residence_permit, p.zup_is_uploaded, p.zup_uploaded_at, p.zup_exported_at, p.planned_exit_date, p.updated_at,
              (SELECT array_agg(DISTINCT dd.category) FROM documents dd WHERE dd.employee_id = p.employee_id AND dd.category LIKE 'hr\\_%' AND dd.deleted_at IS NULL) AS file_categories,
              (SELECT count(*)::int FROM documents dd WHERE dd.employee_id = p.employee_id AND dd.category LIKE 'hr\\_%' AND dd.deleted_at IS NULL) AS files_count,
              (SELECT count(*)::int FROM employee_hr_ocr_conflicts oc WHERE oc.employee_id = p.employee_id AND oc.status = 'open') AS open_conflicts,
              (SELECT count(*)::int FROM documents dd WHERE dd.employee_id = p.employee_id AND dd.category LIKE 'hr\\_%' AND dd.deleted_at IS NULL AND dd.recognition_status IN ('pending','processing')) AS ocr_pending
         FROM employee_hr_profiles p
         JOIN employees e ON e.id = p.employee_id
         LEFT JOIN org_departments d ON d.id = e.org_department_id
         LEFT JOIN hr_citizenships c ON c.id = p.citizenship_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY e.full_name`,
      params,
    );

    const filesFilter = typeof q.files === 'string' ? q.files : '';
    const enriched = rows.map(r => {
      const cit = r.citizenship_id ? { requires_patent: !!r.requires_patent, is_eaeu: !!r.is_eaeu, iso_code: r.iso_code, name: r.citizenship_name ?? undefined } : null;
      const profile = resolveDocumentProfile(cit, r.has_residence_permit);
      const slots = resolveDocumentSlots(profile, r.has_residence_permit);
      const present = new Set((r.file_categories ?? []).map(c => getHrDocumentType(c)?.code ?? c));
      const filled = slots.required.filter(code => present.has(code)).length;
      const completeness: 'full' | 'partial' | 'none' = r.files_count === 0 ? 'none' : filled >= slots.required.length ? 'full' : 'partial';
      return {
        employee_id: r.employee_id,
        full_name: r.full_name,
        employment_status: r.employment_status,
        hire_date: r.hire_date,
        birth_date: r.birth_date,
        department: r.department_name,
        org_department_id: r.org_department_id,
        citizenship: r.citizenship_name,
        requires_patent: requiresPatent(cit, r.has_residence_permit),
        has_residence_permit: r.has_residence_permit,
        planned_exit_date: r.planned_exit_date,
        zup: { is_uploaded: r.zup_is_uploaded, uploaded_at: r.zup_uploaded_at, exported_at: r.zup_exported_at },
        files: { count: r.files_count, required_filled: filled, required_total: slots.required.length, completeness },
        open_conflicts: r.open_conflicts,
        ocr_pending: r.ocr_pending,
        updated_at: r.updated_at,
      };
    }).filter(r => !filesFilter || r.files.completeness === filesFilter);

    const total = enriched.length;
    const start = (page - 1) * pageSize;
    res.json({ success: true, data: enriched.slice(start, start + pageSize), meta: { total, page, pageSize } });
  } catch (err) {
    fail(res, err, 'Ошибка получения списка');
  }
};

/** Сотрудники FOT без профиля (для «Добавить → существующий» и staging). */
const searchEmployees = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q.length < 2) {
      res.json({ success: true, data: [] });
      return;
    }
    const scope = await resolveAccessibleEmployeeIds(req);
    const params: unknown[] = [`%${escapeLike(q)}%`];
    let scopeSql = '';
    if (scope !== 'all') {
      if (scope.size === 0) { res.json({ success: true, data: [] }); return; }
      params.push([...scope]);
      scopeSql = `AND e.id = ANY($2::int[])`;
    }
    const rows = await query(
      `SELECT e.id, e.full_name, e.birth_date, e.employment_status, d.name AS department, (p.employee_id IS NOT NULL) AS has_profile
         FROM employees e LEFT JOIN org_departments d ON d.id = e.org_department_id LEFT JOIN employee_hr_profiles p ON p.employee_id = e.id
        WHERE e.full_name ILIKE $1 AND e.is_archived = false ${scopeSql}
        ORDER BY (e.employment_status = 'active') DESC, e.full_name LIMIT 20`,
      params,
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    fail(res, err, 'Ошибка поиска');
  }
};

const duplicates = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!ensureConfigured(res)) return;
    const s = (k: string): string | null => (typeof req.query[k] === 'string' ? String(req.query[k]).trim() || null : null);
    const exclude = s('exclude_employee_id');
    const data = await findDuplicates(
      { snils: s('snils'), inn: s('inn'), passport_number: s('passport_number'), full_name: s('full_name'), birth_date: s('birth_date') },
      exclude ? Number(exclude) : null,
    );
    res.json({ success: true, data });
  } catch (err) {
    fail(res, err, 'Ошибка проверки дублей');
  }
};

// ─── Профиль ────────────────────────────────────────────────────────────────

const getOne = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!ensureConfigured(res)) return;
    const employeeId = parseEmployeeId(req.params.employeeId);
    if (!employeeId || !(await canAccessEmployeeInScope(req, employeeId))) {
      res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      return;
    }
    const row = await loadProfileRow(employeeId);
    if (!row) {
      const emp = await queryOne<{ id: number; full_name: string }>(`SELECT id, full_name FROM employees WHERE id = $1`, [employeeId]);
      if (!emp) { res.status(404).json({ success: false, error: 'Сотрудник не найден' }); return; }
      res.status(404).json({ success: false, error: 'Реквизиты не заведены', code: 'HR_PROFILE_MISSING', data: { employee_id: emp.id, full_name: emp.full_name, can_create: await canEdit(req) } });
      return;
    }
    res.json({ success: true, data: await buildProfileView(row, { unmask: false }), meta: { can_edit: await canEdit(req) } });
  } catch (err) {
    fail(res, err, 'Ошибка получения профиля');
  }
};

const sensitive = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!ensureConfigured(res)) return;
    const employeeId = parseEmployeeId(req.params.employeeId);
    if (!employeeId || !(await canAccessEmployeeInScope(req, employeeId))) {
      res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      return;
    }
    const row = await loadProfileRow(employeeId);
    if (!row) { res.status(404).json({ success: false, error: 'Реквизиты не заведены' }); return; }
    await auditService.logFromRequest(req, req.user.id, 'HR_PROFILE_VIEW_SENSITIVE', { entityType: 'employee', entityId: String(employeeId) });
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ success: true, data: await buildProfileView(row, { unmask: true }) });
  } catch (err) {
    fail(res, err, 'Ошибка получения профиля');
  }
};

const create = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!ensureConfigured(res)) return;
    const employeeId = parseEmployeeId(req.params.employeeId);
    if (!employeeId || !(await canAccessEmployeeInScope(req, employeeId))) {
      res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      return;
    }
    const emp = await queryOne<{ id: number }>(`SELECT id FROM employees WHERE id = $1`, [employeeId]);
    if (!emp) { res.status(404).json({ success: false, error: 'Сотрудник не найден' }); return; }
    const input = hrProfileInputSchema.parse(req.body ?? {}) as IHrProfileInput;
    const existed = await loadProfileRow(employeeId);
    await createProfile(employeeId, input, { userId: req.user.id }, 'admin');
    await auditService.logFromRequest(req, req.user.id, existed ? 'HR_PROFILE_UPDATE' : 'HR_PROFILE_CREATE', { entityType: 'employee', entityId: String(employeeId) });
    const row = await loadProfileRow(employeeId);
    res.status(existed ? 200 : 201).json({ success: true, data: row ? await buildProfileView(row, { unmask: true }) : null });
  } catch (err) {
    fail(res, err, 'Ошибка создания профиля');
  }
};

const update = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!ensureConfigured(res)) return;
    const employeeId = parseEmployeeId(req.params.employeeId);
    if (!employeeId || !(await canAccessEmployeeInScope(req, employeeId))) {
      res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      return;
    }
    if (!(await loadProfileRow(employeeId))) { res.status(404).json({ success: false, error: 'Реквизиты не заведены' }); return; }
    const input = hrProfileInputSchema.parse(req.body ?? {}) as IHrProfileInput;
    const result = await updateProfile(employeeId, input, { userId: req.user.id }, 'admin');
    if (result.changedFields.length > 0) {
      await auditService.logFromRequest(req, req.user.id, 'HR_PROFILE_UPDATE', {
        entityType: 'employee', entityId: String(employeeId), details: { fields: result.changedFields, zup_reset: result.zupReset },
      });
    }
    const row = await loadProfileRow(employeeId);
    res.json({ success: true, data: row ? await buildProfileView(row, { unmask: true }) : null, meta: result });
  } catch (err) {
    fail(res, err, 'Ошибка сохранения профиля');
  }
};

const history = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!ensureConfigured(res)) return;
    const employeeId = parseEmployeeId(req.params.employeeId);
    if (!employeeId || !(await canAccessEmployeeInScope(req, employeeId))) {
      res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      return;
    }
    res.json({ success: true, data: await listHistory(employeeId, { unmask: await canEdit(req) }) });
  } catch (err) {
    fail(res, err, 'Ошибка получения истории');
  }
};

// ─── ЗУП ────────────────────────────────────────────────────────────────────

const zupToggle = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!ensureConfigured(res)) return;
    const employeeId = parseEmployeeId(req.params.employeeId);
    if (!employeeId || !(await canAccessEmployeeInScope(req, employeeId))) {
      res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      return;
    }
    const body = z.object({ is_uploaded: z.boolean() }).parse(req.body ?? {});
    await setZupUploaded(employeeId, body.is_uploaded, { userId: req.user.id });
    await auditService.logFromRequest(req, req.user.id, 'HR_ZUP_TOGGLE', { entityType: 'employee', entityId: String(employeeId), details: { is_uploaded: body.is_uploaded } });
    res.json({ success: true });
  } catch (err) {
    fail(res, err, 'Ошибка изменения флага ЗУП');
  }
};

const zupBulk = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!ensureConfigured(res)) return;
    const body = z.object({ employee_ids: z.array(z.number().int().positive()).min(1).max(500), is_uploaded: z.boolean() }).parse(req.body ?? {});
    let done = 0;
    for (const id of body.employee_ids) {
      if (!(await canAccessEmployeeInScope(req, id))) continue;
      await setZupUploaded(id, body.is_uploaded, { userId: req.user.id });
      done += 1;
    }
    await auditService.logFromRequest(req, req.user.id, 'HR_ZUP_TOGGLE', { details: { bulk: true, count: done, is_uploaded: body.is_uploaded } });
    res.json({ success: true, data: { updated: done } });
  } catch (err) {
    fail(res, err, 'Ошибка массового изменения ЗУП');
  }
};

const zupExport = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!ensureConfigured(res)) return;
    const idsRaw = typeof req.query.ids === 'string' ? req.query.ids : '';
    const employeeIds = idsRaw.split(',').map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n > 0);
    const rows = await loadRowsForExport({
      employeeIds: employeeIds.length > 0 ? employeeIds : undefined,
      notUploadedOnly: req.query.notUploaded === '1',
      activeOnly: req.query.activeOnly !== '0',
      scopeEmployeeIds: await resolveAccessibleEmployeeIds(req),
    });
    const buffer = await buildZupWorkbook(rows);
    await markZupExported(rows.map(r => r.employee_id), { userId: req.user.id });
    await auditService.logFromRequest(req, req.user.id, 'HR_ZUP_EXPORT', { details: { count: rows.length } });
    const fileName = buildZupFileName();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="export.xlsx"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(buffer);
  } catch (err) {
    fail(res, err, 'Ошибка выгрузки ЗУП');
  }
};

// ─── Конфликты OCR ──────────────────────────────────────────────────────────

interface IConflictRow {
  id: number;
  employee_id: number;
  document_id: number | null;
  document_name: string | null;
  document_category: string | null;
  field_name: string;
  current_value_enc: string | null;
  ocr_value_enc: string | null;
  status: 'open' | 'applied' | 'dismissed';
  resolved_at: string | null;
  created_at: string;
}

const SENSITIVE = new Set(['inn', 'passport_number', 'bank_account_number', 'kig', 'patent_number', 'snils']);

const conflicts = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!ensureConfigured(res)) return;
    const employeeId = parseEmployeeId(req.params.employeeId);
    if (!employeeId || !(await canAccessEmployeeInScope(req, employeeId))) {
      res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      return;
    }
    const unmask = await canEdit(req);
    const rows = await query<IConflictRow>(
      `SELECT c.id, c.employee_id, c.document_id, d.file_name AS document_name, d.category AS document_category,
              c.field_name, c.current_value_enc, c.ocr_value_enc, c.status, c.resolved_at, c.created_at
         FROM employee_hr_ocr_conflicts c LEFT JOIN documents d ON d.id = c.document_id
        WHERE c.employee_id = $1 AND c.status = 'open' ORDER BY c.created_at DESC`,
      [employeeId],
    );
    const labels = new Map(HR_PROFILE_FIELDS.map(f => [f.key, f.label]));
    res.json({
      success: true,
      data: rows.map(r => {
        const cur = decryptFieldSafe(r.current_value_enc);
        const ocr = decryptFieldSafe(r.ocr_value_enc);
        const mask = !unmask && SENSITIVE.has(r.field_name);
        return {
          id: r.id, field_name: r.field_name, field_label: labels.get(r.field_name) ?? r.field_name,
          document_id: r.document_id, document_name: r.document_name,
          document_type: r.document_category ? getHrDocumentType(r.document_category)?.label ?? r.document_category : null,
          current_value: mask ? maskValue(cur) : cur, ocr_value: mask ? maskValue(ocr) : ocr,
          status: r.status, created_at: r.created_at,
        };
      }),
    });
  } catch (err) {
    fail(res, err, 'Ошибка получения расхождений');
  }
};

const resolveConflict = (decision: 'applied' | 'dismissed') => async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!ensureConfigured(res)) return;
    const conflictId = Number(req.params.id);
    const row = await queryOne<IConflictRow>(`SELECT * FROM employee_hr_ocr_conflicts WHERE id = $1`, [conflictId]);
    if (!row) { res.status(404).json({ success: false, error: 'Расхождение не найдено' }); return; }
    if (!(await canAccessEmployeeInScope(req, row.employee_id))) {
      res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      return;
    }
    if (row.status !== 'open') { res.status(409).json({ success: false, error: 'Расхождение уже обработано' }); return; }
    await withTransaction(async client => {
      if (decision === 'applied') {
        const value = decryptFieldSafe(row.ocr_value_enc);
        await applyProfilePatch(client, row.employee_id, { [row.field_name]: value } as IHrProfileInput, { userId: req.user.id }, 'admin', {
          historyEvent: 'ocr_apply', documentId: row.document_id,
        });
      } else {
        await recordHistory(client, row.employee_id, 'ocr_dismiss', { changedFields: [row.field_name], documentId: row.document_id, actor: { userId: req.user.id }, source: 'admin' });
      }
      await client.query(`UPDATE employee_hr_ocr_conflicts SET status = $2, resolved_by = $3, resolved_at = now() WHERE id = $1`, [conflictId, decision, req.user.id]);
    });
    await auditService.logFromRequest(req, req.user.id, decision === 'applied' ? 'HR_OCR_APPLY' : 'HR_OCR_DISMISS', {
      entityType: 'employee', entityId: String(row.employee_id), details: { conflict_id: conflictId, field: row.field_name },
    });
    res.json({ success: true });
  } catch (err) {
    fail(res, err, 'Ошибка обработки расхождения');
  }
};

/** Плоские поля профиля для проверки полноты (используется мастером при attach). */
const plainFieldsForCompare = async (employeeId: number): Promise<Record<string, unknown> | null> => {
  const row = await loadProfileRow(employeeId);
  return row ? rowToPlainFields(row) : null;
};

export const hrProfilesController = {
  catalog,
  departments,
  list,
  searchEmployees,
  duplicates,
  getOne,
  sensitive,
  create,
  update,
  history,
  zupToggle,
  zupBulk,
  zupExport,
  conflicts,
  applyConflict: resolveConflict('applied'),
  dismissConflict: resolveConflict('dismissed'),
  plainFieldsForCompare,
};
