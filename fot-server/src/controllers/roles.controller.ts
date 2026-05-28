import { Response } from 'express';
import { z } from 'zod';
import { query, queryOne, execute, withTransaction } from '../config/postgres.js';
import type { AccessMode } from '../config/access-control.js';
import type { AuthenticatedRequest, SystemRole } from '../types/index.js';
import {
  invalidateRoleListCache,
  invalidateRolePageAccessCache,
} from '../services/access-control.service.js';
import { invalidateCorrectionRestrictionsCache } from '../services/correction-restrictions.service.js';
import {
  loadAccessCatalog,
  normalizeKnownPageAccessModes,
  pageAccessRowsToModes,
  validatePageAccessModes,
} from '../services/access-catalog.service.js';
import { ensureCriticalAdminAccess } from '../services/critical-admin-access.service.js';
import { getIo } from '../socket/io-instance.js';

// Правки роли (окно табеля, is_admin, доступ страниц) зашиты в JWT/state.profile
// и не доходят до активной сессии без релогина. Шлём пользователям этой роли
// существующее событие — фронт (AuthContext) дёрнет /auth/me и пересоберёт токен.
async function emitRoleAccessChanged(roleId: string | null | undefined): Promise<void> {
  if (!roleId) return;
  const io = getIo();
  if (!io) return;
  try {
    const rows = await query<{ id: string }>(
      'SELECT id FROM user_profiles WHERE system_role_id = $1::uuid',
      [roleId],
    );
    for (const { id } of rows) {
      io.to(`user:${id}`).emit('profile:access_changed');
    }
  } catch (error) {
    console.error('[emitRoleAccessChanged] error:', error);
  }
}

const employeeVariantSchema = z.enum(['object', 'office', 'contractor']).nullable().optional();
const timesheetMonthsSchema = z.number().int().min(0).max(12);

const maxCorrectionsSchema = z.number().int().min(0).max(100000).nullable();

const createRoleSchema = z.object({
  code: z.string().min(1).max(50).regex(/^[a-z_]+$/, 'Только строчные буквы и подчёркивание'),
  name: z.string().min(1).max(100),
  description: z.string().max(500).nullable().optional(),
  is_admin: z.boolean().optional().default(false),
  employee_variant: employeeVariantSchema,
  show_actual_hours: z.boolean().optional().default(false),
  hide_sidebar: z.boolean().optional().default(false),
  timesheet_months_back: timesheetMonthsSchema.optional().default(1),
  timesheet_months_forward: timesheetMonthsSchema.optional().default(1),
  timesheet_show_full_period: z.boolean().optional().default(true),
  corrections_anomalies_only: z.boolean().optional().default(false),
  corrections_cap_by_schedule_norm: z.boolean().optional().default(false),
  corrections_allow_zero_short_attendance: z.boolean().optional().default(false),
  corrections_disable_bulk: z.boolean().optional().default(false),
  max_corrections_per_month: maxCorrectionsSchema.optional(),
});

const updateRoleSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).nullable().optional(),
  is_admin: z.boolean().optional(),
  employee_variant: employeeVariantSchema,
  is_active: z.boolean().optional(),
  show_actual_hours: z.boolean().optional(),
  hide_sidebar: z.boolean().optional(),
  timesheet_months_back: timesheetMonthsSchema.optional(),
  timesheet_months_forward: timesheetMonthsSchema.optional(),
  timesheet_show_full_period: z.boolean().optional(),
  corrections_anomalies_only: z.boolean().optional(),
  corrections_cap_by_schedule_norm: z.boolean().optional(),
  corrections_allow_zero_short_attendance: z.boolean().optional(),
  corrections_disable_bulk: z.boolean().optional(),
  max_corrections_per_month: maxCorrectionsSchema.optional(),
});

const updateAccessProfileSchema = z.object({
  page_access: z.record(z.enum(['none', 'view', 'edit'])).optional().default({}),
});

const cloneRoleSchema = z.object({
  code: z.string().min(1).max(50).regex(/^[a-z_]+$/, 'Только строчные буквы и подчёркивание'),
  name: z.string().min(1).max(100),
  description: z.string().max(500).nullable().optional(),
  is_admin: z.boolean().optional(),
  employee_variant: employeeVariantSchema,
  is_active: z.boolean().optional(),
  show_actual_hours: z.boolean().optional(),
  hide_sidebar: z.boolean().optional(),
  timesheet_months_back: timesheetMonthsSchema.optional(),
  timesheet_months_forward: timesheetMonthsSchema.optional(),
  timesheet_show_full_period: z.boolean().optional(),
  corrections_anomalies_only: z.boolean().optional(),
  corrections_cap_by_schedule_norm: z.boolean().optional(),
  corrections_allow_zero_short_attendance: z.boolean().optional(),
  corrections_disable_bulk: z.boolean().optional(),
  max_corrections_per_month: maxCorrectionsSchema.optional(),
});

function isMissingFunctionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: string }).code ?? null;
  const message = 'message' in error ? String((error as { message?: unknown }).message || '') : '';
  return (
    code === '42883'
    || code === '42703'
    || /function .* does not exist/i.test(message)
    || /column .* does not exist/i.test(message)
  );
}

async function loadRoleByCode(code: string): Promise<SystemRole | null> {
  const row = await queryOne<SystemRole>(
    `SELECT * FROM system_roles WHERE code = $1`,
    [code],
  );
  return row;
}

async function loadRoleAccessRows(roleCode: string) {
  return query<{
    role_code: string;
    page_path: string;
    can_view: boolean;
    can_edit: boolean;
  }>(
    `SELECT role_code, page_path, can_view, can_edit
       FROM role_page_access
      WHERE role_code = $1`,
    [roleCode],
  );
}

async function loadRoleAccessModes(roleCode: string): Promise<Record<string, AccessMode>> {
  const rows = await loadRoleAccessRows(roleCode);
  return normalizeKnownPageAccessModes(
    pageAccessRowsToModes(
      rows.map((row) => ({
        role_code: row.role_code,
        page_path: row.page_path,
        can_view: row.can_view,
        can_edit: row.can_edit,
      })),
    ),
  );
}

async function persistAccessProfileFallback(
  roleCode: string,
  pageAccess: Record<string, AccessMode>,
): Promise<void> {
  const grantedEntries = Object.entries(pageAccess)
    .filter(([, mode]) => mode !== 'none')
    .map(([pagePath, mode]) => ({
      role_code: roleCode,
      page_path: pagePath,
      can_view: mode === 'view' || mode === 'edit',
      can_edit: mode === 'edit',
    }));

  await withTransaction(async client => {
    await client.query(`DELETE FROM role_page_access WHERE role_code = $1`, [roleCode]);
    if (grantedEntries.length === 0) return;
    const params: unknown[] = [];
    const placeholders: string[] = [];
    for (const entry of grantedEntries) {
      const groupPlaceholders: string[] = [];
      for (const col of ['role_code', 'page_path', 'can_view', 'can_edit'] as const) {
        params.push(entry[col]);
        groupPlaceholders.push(`$${params.length}`);
      }
      placeholders.push(`(${groupPlaceholders.join(', ')})`);
    }
    await client.query(
      `INSERT INTO role_page_access (role_code, page_path, can_view, can_edit)
       VALUES ${placeholders.join(', ')}`,
      params,
    );
  });
}

async function persistAccessProfile(
  roleCode: string,
  pageAccess: Record<string, AccessMode>,
): Promise<void> {
  const payload = Object.entries(pageAccess).map(([key, mode]) => ({ key, mode }));
  try {
    await execute(
      `SELECT public.replace_role_access_profile($1, $2::jsonb, $3::jsonb)`,
      [roleCode, JSON.stringify([]), JSON.stringify(payload)],
    );
    return;
  } catch (error) {
    if (!isMissingFunctionError(error)) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  }
  await persistAccessProfileFallback(roleCode, pageAccess);
}

export const rolesController = {
  async getRoles(_req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const data = await query<SystemRole>(
        `SELECT * FROM system_roles
          ORDER BY is_admin DESC, name ASC`,
      );
      res.json({ success: true, data });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to load roles',
      });
    }
  },

  // Минимальный список ролей для UI: только code/name/is_admin активных ролей.
  // Используется AuthContext.loadRoles() для подписей в чате/админке без раскрытия
  // структуры прав. Доступ — любой authenticated (см. roles.routes.ts).
  async getLabels(_req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const data = await query<{ code: string; name: string; is_admin: boolean; show_actual_hours: boolean }>(
        `SELECT code, name, is_admin, show_actual_hours
           FROM system_roles
          WHERE is_active = true
          ORDER BY is_admin DESC, name ASC`,
      );
      res.json({ success: true, data });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to load role labels',
      });
    }
  },

  async getCatalog(_req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const data = await loadAccessCatalog();
      res.json({ success: true, data });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to load access catalog',
      });
    }
  },

  async getAccessProfile(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const role = await loadRoleByCode(req.params.code);
      if (!role) {
        res.status(404).json({ success: false, error: 'Роль не найдена' });
        return;
      }

      const page_access = await loadRoleAccessModes(role.code);

      res.json({ success: true, data: { role, page_access } });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to load access profile',
      });
    }
  },

  async createRole(req: AuthenticatedRequest, res: Response): Promise<void> {
    const parsed = createRoleSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: parsed.error.errors[0].message });
      return;
    }

    const {
      code,
      name,
      description,
      is_admin,
      employee_variant,
      show_actual_hours,
      hide_sidebar,
      timesheet_months_back,
      timesheet_months_forward,
      timesheet_show_full_period,
      corrections_anomalies_only,
      corrections_cap_by_schedule_norm,
      corrections_allow_zero_short_attendance,
      corrections_disable_bulk,
      max_corrections_per_month,
    } = parsed.data;

    let data: SystemRole | null;
    try {
      data = await queryOne<SystemRole>(
        `INSERT INTO system_roles
           (code, name, description, is_admin, employee_variant, show_actual_hours, hide_sidebar,
            timesheet_months_back, timesheet_months_forward, timesheet_show_full_period,
            corrections_anomalies_only, corrections_cap_by_schedule_norm,
            corrections_allow_zero_short_attendance, corrections_disable_bulk,
            max_corrections_per_month, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, true)
         RETURNING *`,
        [
          code,
          name,
          description ?? null,
          !!is_admin,
          employee_variant ?? null,
          !!show_actual_hours,
          !!hide_sidebar,
          timesheet_months_back ?? 1,
          timesheet_months_forward ?? 1,
          timesheet_show_full_period ?? true,
          !!corrections_anomalies_only,
          !!corrections_cap_by_schedule_norm,
          !!corrections_allow_zero_short_attendance,
          !!corrections_disable_bulk,
          max_corrections_per_month ?? null,
        ],
      );
    } catch (error) {
      const errCode = (error as { code?: string }).code;
      if (errCode === '23505') {
        res.status(409).json({ success: false, error: 'Роль с таким кодом уже существует' });
      } else {
        res.status(500).json({
          success: false,
          error: error instanceof Error ? error.message : 'Не удалось создать роль',
        });
      }
      return;
    }
    if (!data) {
      res.status(500).json({ success: false, error: 'Не удалось создать роль' });
      return;
    }

    invalidateRoleListCache();
    res.status(201).json({ success: true, data });
  },

  async cloneRole(req: AuthenticatedRequest, res: Response): Promise<void> {
    const { code: sourceCode } = req.params;
    const parsed = cloneRoleSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: parsed.error.errors[0].message });
      return;
    }

    try {
      const sourceRole = await loadRoleByCode(sourceCode);
      if (!sourceRole) {
        res.status(404).json({ success: false, error: 'Исходная роль не найдена' });
        return;
      }

      const page_access = await loadRoleAccessModes(sourceRole.code);
      const targetCode = parsed.data.code;

      const pageError = await validatePageAccessModes(page_access);
      if (pageError) {
        res.status(400).json({ success: false, error: pageError });
        return;
      }

      let createdRole: SystemRole | null;
      try {
        createdRole = await queryOne<SystemRole>(
          `INSERT INTO system_roles
             (code, name, description, is_admin, employee_variant, show_actual_hours, hide_sidebar,
              timesheet_months_back, timesheet_months_forward, timesheet_show_full_period,
              corrections_anomalies_only, corrections_cap_by_schedule_norm,
              corrections_allow_zero_short_attendance, corrections_disable_bulk,
              max_corrections_per_month, is_active)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
           RETURNING *`,
          [
            targetCode,
            parsed.data.name,
            parsed.data.description ?? sourceRole.description ?? null,
            parsed.data.is_admin ?? sourceRole.is_admin,
            parsed.data.employee_variant !== undefined
              ? parsed.data.employee_variant
              : sourceRole.employee_variant,
            parsed.data.show_actual_hours ?? sourceRole.show_actual_hours,
            parsed.data.hide_sidebar ?? sourceRole.hide_sidebar,
            parsed.data.timesheet_months_back ?? sourceRole.timesheet_months_back ?? 1,
            parsed.data.timesheet_months_forward ?? sourceRole.timesheet_months_forward ?? 1,
            parsed.data.timesheet_show_full_period ?? sourceRole.timesheet_show_full_period ?? true,
            parsed.data.corrections_anomalies_only ?? sourceRole.corrections_anomalies_only ?? false,
            parsed.data.corrections_cap_by_schedule_norm ?? sourceRole.corrections_cap_by_schedule_norm ?? false,
            parsed.data.corrections_allow_zero_short_attendance ?? sourceRole.corrections_allow_zero_short_attendance ?? false,
            parsed.data.corrections_disable_bulk ?? sourceRole.corrections_disable_bulk ?? false,
            parsed.data.max_corrections_per_month !== undefined
              ? parsed.data.max_corrections_per_month
              : (sourceRole.max_corrections_per_month ?? null),
            parsed.data.is_active ?? true,
          ],
        );
      } catch (createError) {
        const errCode = (createError as { code?: string }).code;
        if (errCode === '23505') {
          res.status(409).json({ success: false, error: 'Роль с таким кодом уже существует' });
        } else {
          res.status(500).json({
            success: false,
            error: createError instanceof Error ? createError.message : 'Не удалось создать роль',
          });
        }
        return;
      }
      if (!createdRole) {
        res.status(500).json({ success: false, error: 'Не удалось создать роль' });
        return;
      }

      await persistAccessProfile(targetCode, page_access);
      invalidateRoleListCache();
      invalidateRolePageAccessCache();
      res.status(201).json({ success: true, data: createdRole });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to clone role',
      });
    }
  },

  async updateRole(req: AuthenticatedRequest, res: Response): Promise<void> {
    const { code } = req.params;
    const parsed = updateRoleSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: parsed.error.errors[0].message });
      return;
    }

    const currentRole = await loadRoleByCode(code);
    if (!currentRole) {
      res.status(404).json({ success: false, error: 'Роль не найдена' });
      return;
    }

    if (parsed.data.is_active === false && currentRole.is_active) {
      try {
        await ensureCriticalAdminAccess({ roleActiveByCode: { [code]: false } });
      } catch (error) {
        res.status(400).json({
          success: false,
          error: error instanceof Error
            ? error.message
            : 'Невозможно деактивировать последнюю администраторскую роль',
        });
        return;
      }
    }

    const setClauses: string[] = [];
    const params: unknown[] = [];
    const addParam = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };

    setClauses.push(`name = ${addParam(parsed.data.name)}`);
    setClauses.push(`description = ${addParam(parsed.data.description ?? null)}`);
    setClauses.push(`updated_at = ${addParam(new Date().toISOString())}`);
    if (parsed.data.is_active !== undefined) setClauses.push(`is_active = ${addParam(parsed.data.is_active)}`);
    if (parsed.data.is_admin !== undefined) setClauses.push(`is_admin = ${addParam(parsed.data.is_admin)}`);
    if (parsed.data.employee_variant !== undefined) setClauses.push(`employee_variant = ${addParam(parsed.data.employee_variant)}`);
    if (parsed.data.show_actual_hours !== undefined) setClauses.push(`show_actual_hours = ${addParam(parsed.data.show_actual_hours)}`);
    if (parsed.data.hide_sidebar !== undefined) setClauses.push(`hide_sidebar = ${addParam(parsed.data.hide_sidebar)}`);
    if (parsed.data.timesheet_months_back !== undefined) setClauses.push(`timesheet_months_back = ${addParam(parsed.data.timesheet_months_back)}`);
    if (parsed.data.timesheet_months_forward !== undefined) setClauses.push(`timesheet_months_forward = ${addParam(parsed.data.timesheet_months_forward)}`);
    if (parsed.data.timesheet_show_full_period !== undefined) setClauses.push(`timesheet_show_full_period = ${addParam(parsed.data.timesheet_show_full_period)}`);
    if (parsed.data.corrections_anomalies_only !== undefined) setClauses.push(`corrections_anomalies_only = ${addParam(parsed.data.corrections_anomalies_only)}`);
    if (parsed.data.corrections_cap_by_schedule_norm !== undefined) setClauses.push(`corrections_cap_by_schedule_norm = ${addParam(parsed.data.corrections_cap_by_schedule_norm)}`);
    if (parsed.data.corrections_allow_zero_short_attendance !== undefined) setClauses.push(`corrections_allow_zero_short_attendance = ${addParam(parsed.data.corrections_allow_zero_short_attendance)}`);
    if (parsed.data.corrections_disable_bulk !== undefined) setClauses.push(`corrections_disable_bulk = ${addParam(parsed.data.corrections_disable_bulk)}`);
    if (parsed.data.max_corrections_per_month !== undefined) setClauses.push(`max_corrections_per_month = ${addParam(parsed.data.max_corrections_per_month)}`);

    const codePlaceholder = addParam(code);

    let data: SystemRole | null;
    try {
      data = await queryOne<SystemRole>(
        `UPDATE system_roles SET ${setClauses.join(', ')}
           WHERE code = ${codePlaceholder}
           RETURNING *`,
        params,
      );
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Не удалось обновить роль',
      });
      return;
    }
    if (!data) {
      res.status(500).json({ success: false, error: 'Не удалось обновить роль' });
      return;
    }

    invalidateRoleListCache();
    invalidateCorrectionRestrictionsCache(data.id);
    await emitRoleAccessChanged(data.id);
    res.json({ success: true, data });
  },

  async updateAccessProfile(req: AuthenticatedRequest, res: Response): Promise<void> {
    const { code } = req.params;
    const parsed = updateAccessProfileSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'Неверный формат данных профиля доступа' });
      return;
    }

    try {
      const role = await loadRoleByCode(code);
      if (!role) {
        res.status(404).json({ success: false, error: 'Роль не найдена' });
        return;
      }

      const page_access = Object.fromEntries(
        Object.entries(parsed.data.page_access || {}).map(([pageKey, mode]) => [pageKey, mode as AccessMode]),
      );

      const pageError = await validatePageAccessModes(page_access);
      if (pageError) {
        res.status(400).json({ success: false, error: pageError });
        return;
      }

      if (role.is_active) {
        try {
          await ensureCriticalAdminAccess({ rolePageAccessByCode: { [code]: page_access } });
        } catch (error) {
          res.status(400).json({
            success: false,
            error: error instanceof Error
              ? error.message
              : 'Нельзя снять последний критичный доступ администрирования',
          });
          return;
        }
      }

      await persistAccessProfile(code, page_access);
      invalidateRoleListCache();
      invalidateRolePageAccessCache();
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Не удалось сохранить профиль доступа',
      });
    }
  },

  async deleteRole(req: AuthenticatedRequest, res: Response): Promise<void> {
    const { code } = req.params;
    const role = await loadRoleByCode(code);

    if (!role) {
      res.status(404).json({ success: false, error: 'Роль не найдена' });
      return;
    }

    if (code === 'admin') {
      res.status(400).json({
        success: false,
        error: 'Системную роль «admin» удалить нельзя',
      });
      return;
    }

    try {
      await ensureCriticalAdminAccess({ removedRoleCodes: [code] });
    } catch (error) {
      res.status(400).json({
        success: false,
        error: error instanceof Error
          ? error.message
          : 'Нельзя удалить последнюю администраторскую роль',
      });
      return;
    }

    try {
      await execute(`DELETE FROM system_roles WHERE code = $1`, [code]);
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Не удалось удалить роль',
      });
      return;
    }

    invalidateRoleListCache();
    invalidateRolePageAccessCache();
    res.json({ success: true });
  },
};
