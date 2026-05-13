import { Response } from 'express';
import { z } from 'zod';
import { query, queryOne, execute, withTransaction } from '../config/postgres.js';
import type { AccessMode } from '../config/access-control.js';
import type { AuthenticatedRequest, SystemRole } from '../types/index.js';
import {
  invalidateRoleListCache,
  invalidateRolePageAccessCache,
} from '../services/access-control.service.js';
import {
  loadAccessCatalog,
  normalizeKnownPageAccessModes,
  pageAccessRowsToModes,
  validatePageAccessModes,
} from '../services/access-catalog.service.js';
import { ensureCriticalAdminAccess } from '../services/critical-admin-access.service.js';

const employeeVariantSchema = z.enum(['object', 'office']).nullable().optional();

const createRoleSchema = z.object({
  code: z.string().min(1).max(50).regex(/^[a-z_]+$/, 'Только строчные буквы и подчёркивание'),
  name: z.string().min(1).max(100),
  description: z.string().max(500).nullable().optional(),
  is_admin: z.boolean().optional().default(false),
  employee_variant: employeeVariantSchema,
  show_actual_hours: z.boolean().optional().default(false),
});

const updateRoleSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).nullable().optional(),
  is_admin: z.boolean().optional(),
  employee_variant: employeeVariantSchema,
  is_active: z.boolean().optional(),
  show_actual_hours: z.boolean().optional(),
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

    const { code, name, description, is_admin, employee_variant, show_actual_hours } = parsed.data;

    let data: SystemRole | null;
    try {
      data = await queryOne<SystemRole>(
        `INSERT INTO system_roles
           (code, name, description, is_admin, employee_variant, show_actual_hours, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, true)
         RETURNING *`,
        [code, name, description ?? null, !!is_admin, employee_variant ?? null, !!show_actual_hours],
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
             (code, name, description, is_admin, employee_variant, show_actual_hours, is_active)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
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
