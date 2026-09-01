/**
 * «Несопоставленные» — сотрудники PassDesk, которых скрипт переноса не смог
 * однозначно привязать. Только is_admin (скоуп по отделам к ним неприменим).
 * Привязка создаёт профиль по payload; файлы докачивает повторный прогон скрипта.
 */
import type { Response } from 'express';
import { z } from 'zod';
import { query, queryOne, execute } from '../config/postgres.js';
import type { AuthenticatedRequest } from '../types/index.js';
import { auditService } from '../services/audit.service.js';
import { decryptJson, isHrCryptoConfigured, maskValue } from '../services/hr-crypto.service.js';
import { createProfile, findCitizenshipByValue, type IHrProfileInput } from '../services/hr-profile.service.js';

interface IStagingRow {
  passdesk_id: string;
  full_name: string;
  birth_date: string | null;
  citizenship: string | null;
  counterparty: string | null;
  is_active: boolean | null;
  match_state: string;
  candidate_employee_ids: number[] | null;
  payload_enc: string;
  files: Array<{ source_id: string; document_type: string; file_name: string; size: number }>;
  linked_employee_id: number | null;
  linked_at: string | null;
  created_at: string;
}

interface IStagingPayload {
  profile?: IHrProfileInput & { citizenship_name?: string | null };
  passdesk_id_all?: string | null;
  employee?: Record<string, unknown>;
}

const SENSITIVE = ['inn', 'passport_number', 'bank_account_number', 'kig', 'patent_number', 'snils'] as const;

const list = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!isHrCryptoConfigured()) {
      res.status(503).json({ success: false, error: 'Кадровый модуль не настроен' });
      return;
    }
    const state = typeof req.query.state === 'string' ? req.query.state : null;
    const rows = await query<IStagingRow>(
      `SELECT * FROM hr_profile_import_staging ${state ? 'WHERE match_state = $1' : "WHERE match_state IN ('unmatched','candidate','ambiguous')"} ORDER BY full_name`,
      state ? [state] : [],
    );
    const candidateIds = [...new Set(rows.flatMap(r => r.candidate_employee_ids ?? []))];
    const candidates = candidateIds.length > 0
      ? await query<{ id: number; full_name: string; birth_date: string | null; department: string | null; employment_status: string }>(
        `SELECT e.id, e.full_name, e.birth_date, d.name AS department, e.employment_status
           FROM employees e LEFT JOIN org_departments d ON d.id = e.org_department_id WHERE e.id = ANY($1::int[])`,
        [candidateIds],
      )
      : [];
    const byId = new Map(candidates.map(c => [c.id, c]));
    res.json({
      success: true,
      data: rows.map(r => ({
        passdesk_id: r.passdesk_id,
        full_name: r.full_name,
        birth_date: r.birth_date,
        citizenship: r.citizenship,
        counterparty: r.counterparty,
        is_active: r.is_active,
        match_state: r.match_state,
        candidates: (r.candidate_employee_ids ?? []).map(id => byId.get(id)).filter(Boolean),
        files_count: Array.isArray(r.files) ? r.files.length : 0,
        linked_employee_id: r.linked_employee_id,
        linked_at: r.linked_at,
      })),
    });
  } catch (err) {
    console.error('[hr-staging] list error:', err instanceof Error ? err.message : err);
    res.status(500).json({ success: false, error: 'Ошибка получения списка' });
  }
};

/** Payload для предзаполнения мастера (чувствительные поля маскируются, если не unmask=1). */
const get = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const row = await queryOne<IStagingRow>(`SELECT * FROM hr_profile_import_staging WHERE passdesk_id = $1`, [req.params.id]);
    if (!row) {
      res.status(404).json({ success: false, error: 'Запись не найдена' });
      return;
    }
    const payload = decryptJson<IStagingPayload>(row.payload_enc) ?? {};
    const profile: Record<string, unknown> = { ...(payload.profile ?? {}) };
    if (req.query.unmask !== '1') {
      for (const key of SENSITIVE) if (typeof profile[key] === 'string') profile[key] = maskValue(profile[key] as string);
    } else {
      await auditService.logFromRequest(req, req.user.id, 'HR_PROFILE_VIEW_SENSITIVE', { entityType: 'hr_staging', entityId: row.passdesk_id });
    }
    res.json({ success: true, data: { passdesk_id: row.passdesk_id, full_name: row.full_name, birth_date: row.birth_date, match_state: row.match_state, profile, employee: payload.employee ?? null, files: row.files } });
  } catch (err) {
    console.error('[hr-staging] get error:', err instanceof Error ? err.message : err);
    res.status(500).json({ success: false, error: 'Ошибка получения записи' });
  }
};

const link = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const body = z.object({ employee_id: z.number().int().positive(), mode: z.enum(['linked', 'created']).default('linked') }).parse(req.body ?? {});
    const row = await queryOne<IStagingRow>(`SELECT * FROM hr_profile_import_staging WHERE passdesk_id = $1`, [req.params.id]);
    if (!row) {
      res.status(404).json({ success: false, error: 'Запись не найдена' });
      return;
    }
    if (row.linked_employee_id) {
      res.status(409).json({ success: false, error: `Уже привязано к сотруднику #${row.linked_employee_id}` });
      return;
    }
    const employee = await queryOne<{ id: number }>(`SELECT id FROM employees WHERE id = $1`, [body.employee_id]);
    if (!employee) {
      res.status(404).json({ success: false, error: 'Сотрудник не найден' });
      return;
    }
    const payload = decryptJson<IStagingPayload>(row.payload_enc) ?? {};
    const input: IHrProfileInput = { ...(payload.profile ?? {}) };
    delete (input as Record<string, unknown>).citizenship_name;
    if (!input.citizenship_id && payload.profile?.citizenship_name) {
      const cit = await findCitizenshipByValue(payload.profile.citizenship_name);
      if (cit) input.citizenship_id = cit.id;
    }
    await createProfile(body.employee_id, input, { userId: req.user.id }, 'import', {
      passdeskId: row.passdesk_id,
      passdeskIdAll: payload.passdesk_id_all ?? null,
      matchRule: 'manual',
    });
    await execute(
      `INSERT INTO hr_external_refs (source_system, entity_type, source_id, entity_id) VALUES ('passdesk', 'employee_profile', $1, $2)
       ON CONFLICT (source_system, entity_type, source_id) DO UPDATE SET entity_id = EXCLUDED.entity_id`,
      [row.passdesk_id, body.employee_id],
    );
    await execute(
      `UPDATE hr_profile_import_staging SET match_state = $2, linked_employee_id = $3, linked_by = $4, linked_at = now() WHERE passdesk_id = $1`,
      [row.passdesk_id, body.mode, body.employee_id, req.user.id],
    );
    await auditService.logFromRequest(req, req.user.id, 'HR_STAGING_LINK', {
      entityType: 'employee', entityId: String(body.employee_id), details: { passdesk_id: row.passdesk_id, mode: body.mode, files_pending: Array.isArray(row.files) ? row.files.length : 0 },
    });
    res.json({ success: true, data: { employee_id: body.employee_id, files_pending: Array.isArray(row.files) ? row.files.length : 0 } });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ success: false, error: err.errors[0]?.message ?? 'Некорректные данные' });
      return;
    }
    console.error('[hr-staging] link error:', err instanceof Error ? err.message : err);
    res.status(500).json({ success: false, error: 'Ошибка привязки' });
  }
};

export const hrStagingController = { list, get, link };
