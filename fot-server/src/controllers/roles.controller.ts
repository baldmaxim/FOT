import { Response } from 'express';
import { z } from 'zod';
import { supabase } from '../config/database.js';
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
  const code = 'code' in error ? error.code : null;
  const message = 'message' in error ? String(error.message || '') : '';
  return (
    code === '42883'
    || code === '42703'
    || code === 'PGRST202'
    || /function .* does not exist/i.test(message)
    || /column .* does not exist/i.test(message)
    || /schema cache/i.test(message)
    || /Could not find the function/i.test(message)
  );
}

async function loadRoleByCode(code: string): Promise<SystemRole | null> {
  const { data, error } = await supabase
    .from('system_roles')
    .select('*')
    .eq('code', code)
    .single();
  if (error || !data) return null;
  return data as SystemRole;
}

async function loadRoleAccessRows(roleCode: string) {
  const { data, error } = await supabase
    .from('role_page_access')
    .select('role_code, page_path, can_view, can_edit')
    .eq('role_code', roleCode);
  if (error) throw new Error(`Failed to load role access: ${error.message}`);
  return data || [];
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

  const { error: deleteError } = await supabase
    .from('role_page_access')
    .delete()
    .eq('role_code', roleCode);
  if (deleteError) throw new Error(deleteError.message);

  if (grantedEntries.length === 0) return;

  const { error: insertError } = await supabase
    .from('role_page_access')
    .insert(grantedEntries);
  if (insertError) throw new Error(insertError.message);
}

async function persistAccessProfile(
  roleCode: string,
  pageAccess: Record<string, AccessMode>,
): Promise<void> {
  const payload = Object.entries(pageAccess).map(([key, mode]) => ({ key, mode }));
  const { error } = await supabase.rpc('replace_role_access_profile', {
    p_role_code: roleCode,
    p_permissions: [],
    p_page_access: payload,
  });
  if (!error) return;
  if (!isMissingFunctionError(error)) throw new Error(error.message);
  await persistAccessProfileFallback(roleCode, pageAccess);
}

export const rolesController = {
  async getRoles(_req: AuthenticatedRequest, res: Response): Promise<void> {
    const { data, error } = await supabase
      .from('system_roles')
      .select('*')
      .order('is_admin', { ascending: false })
      .order('name', { ascending: true });

    if (error) {
      res.status(500).json({ success: false, error: error.message });
      return;
    }
    res.json({ success: true, data });
  },

  // Минимальный список ролей для UI: только code/name/is_admin активных ролей.
  // Используется AuthContext.loadRoles() для подписей в чате/админке без раскрытия
  // структуры прав. Доступ — любой authenticated (см. roles.routes.ts).
  async getLabels(_req: AuthenticatedRequest, res: Response): Promise<void> {
    const { data, error } = await supabase
      .from('system_roles')
      .select('code, name, is_admin, show_actual_hours')
      .eq('is_active', true)
      .order('is_admin', { ascending: false })
      .order('name', { ascending: true });

    if (error) {
      res.status(500).json({ success: false, error: error.message });
      return;
    }
    res.json({ success: true, data });
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

    const { data, error } = await supabase
      .from('system_roles')
      .insert({
        code,
        name,
        description: description ?? null,
        is_admin: !!is_admin,
        employee_variant: employee_variant ?? null,
        show_actual_hours: !!show_actual_hours,
        is_active: true,
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        res.status(409).json({ success: false, error: 'Роль с таким кодом уже существует' });
      } else {
        res.status(500).json({ success: false, error: error.message });
      }
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

      const { data: createdRole, error: createError } = await supabase
        .from('system_roles')
        .insert({
          code: targetCode,
          name: parsed.data.name,
          description: parsed.data.description ?? sourceRole.description ?? null,
          is_admin: parsed.data.is_admin ?? sourceRole.is_admin,
          employee_variant: parsed.data.employee_variant !== undefined
            ? parsed.data.employee_variant
            : sourceRole.employee_variant,
          show_actual_hours: parsed.data.show_actual_hours ?? sourceRole.show_actual_hours,
          is_active: parsed.data.is_active ?? true,
        })
        .select()
        .single();

      if (createError || !createdRole) {
        if (createError?.code === '23505') {
          res.status(409).json({ success: false, error: 'Роль с таким кодом уже существует' });
        } else {
          res.status(500).json({
            success: false,
            error: createError?.message || 'Не удалось создать роль',
          });
        }
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

    const updates: Record<string, unknown> = {
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      updated_at: new Date().toISOString(),
    };
    if (parsed.data.is_active !== undefined) updates.is_active = parsed.data.is_active;
    if (parsed.data.is_admin !== undefined) updates.is_admin = parsed.data.is_admin;
    if (parsed.data.employee_variant !== undefined) updates.employee_variant = parsed.data.employee_variant;
    if (parsed.data.show_actual_hours !== undefined) updates.show_actual_hours = parsed.data.show_actual_hours;

    const { data, error } = await supabase
      .from('system_roles')
      .update(updates)
      .eq('code', code)
      .select()
      .single();

    if (error || !data) {
      res.status(500).json({ success: false, error: error?.message || 'Не удалось обновить роль' });
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

    const { error } = await supabase
      .from('system_roles')
      .delete()
      .eq('code', code);

    if (error) {
      res.status(500).json({ success: false, error: error.message });
      return;
    }

    invalidateRoleListCache();
    invalidateRolePageAccessCache();
    res.json({ success: true });
  },
};
