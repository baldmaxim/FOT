import { Response } from 'express';
import { z } from 'zod';
import { supabase } from '../config/database.js';
import {
  normalizePermissions,
  type AccessMode,
} from '../config/access-control.js';
import type { AuthenticatedRequest, SystemRole } from '../types/index.js';
import { invalidateAccessControlCache } from '../services/access-control.service.js';
import {
  loadAccessCatalog,
  normalizeKnownPageAccessModes,
  pageAccessRowsToModes,
  validateRoleConfiguration,
} from '../services/access-catalog.service.js';
import { ensureCriticalAdminAccess } from '../services/critical-admin-access.service.js';

const createRoleSchema = z.object({
  code: z.string().min(1).max(50).regex(/^[a-z_]+$/, 'Только строчные буквы и подчёркивание'),
  name: z.string().min(1).max(100),
  description: z.string().max(500).nullable().optional(),
  level: z.number().int().min(0).max(100),
  permissions: z.array(z.string()).optional().default([]),
});

const updateRoleSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).nullable().optional(),
  level: z.number().int().min(0).max(100),
  is_active: z.boolean().optional(),
  permissions: z.array(z.string()).optional(),
});

const updateAccessProfileSchema = z.object({
  permissions: z.array(z.string()).optional().default([]),
  page_access: z.record(z.enum(['none', 'view', 'edit'])).optional().default({}),
});

const cloneRoleSchema = z.object({
  code: z.string().min(1).max(50).regex(/^[a-z_]+$/, 'Только строчные буквы и подчёркивание'),
  name: z.string().min(1).max(100),
  description: z.string().max(500).nullable().optional(),
  level: z.number().int().min(0).max(100).optional(),
  is_active: z.boolean().optional(),
});

function isMissingFunctionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;

  const code = 'code' in error ? error.code : null;
  const message = 'message' in error ? String(error.message || '') : '';

  return (
    code === '42883'
    || code === 'PGRST202'
    || /function .* does not exist/i.test(message)
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

  if (error || !data) {
    return null;
  }

  return data as SystemRole;
}

async function loadRoleAccessRows(roleCode: string) {
  const { data, error } = await supabase
    .from('role_page_access')
    .select('role_code, page_path, can_view, can_edit')
    .eq('role_code', roleCode);

  if (error) {
    throw new Error(`Failed to load role access: ${error.message}`);
  }

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
  roleId: string,
  permissions: string[],
  pageAccess: Record<string, AccessMode>,
): Promise<void> {
  const grantedEntries = Object.entries(pageAccess)
    .filter(([, mode]) => mode !== 'none')
    .map(([pagePath, mode]) => ({
      role_code: roleCode,
      system_role_id: roleId,
      page_path: pagePath,
      can_view: mode === 'view' || mode === 'edit',
      can_edit: mode === 'edit',
    }));

  const { error: roleError } = await supabase
    .from('system_roles')
    .update({
      permissions,
      updated_at: new Date().toISOString(),
    })
    .eq('code', roleCode);

  if (roleError) {
    throw new Error(roleError.message);
  }

  const { error: deleteError } = await supabase
    .from('role_page_access')
    .delete()
    .eq('role_code', roleCode);

  if (deleteError) {
    throw new Error(deleteError.message);
  }

  if (grantedEntries.length === 0) {
    return;
  }

  const { error: insertError } = await supabase
    .from('role_page_access')
    .insert(grantedEntries);

  if (insertError) {
    throw new Error(insertError.message);
  }
}

async function persistAccessProfile(
  roleCode: string,
  roleId: string,
  permissions: string[],
  pageAccess: Record<string, AccessMode>,
): Promise<void> {
  const payload = Object.entries(pageAccess).map(([key, mode]) => ({ key, mode }));
  const { error } = await supabase.rpc('replace_role_access_profile', {
    p_role_code: roleCode,
    p_permissions: permissions,
    p_page_access: payload,
  });

  if (!error) {
    return;
  }

  if (!isMissingFunctionError(error)) {
    throw new Error(error.message);
  }

  await persistAccessProfileFallback(roleCode, roleId, permissions, pageAccess);
}

export const rolesController = {
  async getRoles(_req: AuthenticatedRequest, res: Response): Promise<void> {
    const { data, error } = await supabase
      .from('system_roles')
      .select('*')
      .order('level', { ascending: true });

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
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Failed to load access catalog' });
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
      res.json({
        success: true,
        data: {
          role,
          permissions: normalizePermissions(role.permissions),
          page_access,
        },
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Failed to load access profile' });
    }
  },

  async createRole(req: AuthenticatedRequest, res: Response): Promise<void> {
    const parsed = createRoleSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: parsed.error.errors[0].message });
      return;
    }

    const { code, name, description, level } = parsed.data;
    const permissions = normalizePermissions(parsed.data.permissions);
    const configError = await validateRoleConfiguration(code, permissions, {});
    if (configError) {
      res.status(400).json({ success: false, error: configError });
      return;
    }

    const { data, error } = await supabase
      .from('system_roles')
      .insert({
        code,
        name,
        description: description ?? null,
        permissions,
        level,
        is_active: true,
        is_system: false,
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

    invalidateAccessControlCache();
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
      const permissions = normalizePermissions(sourceRole.permissions);
      const targetCode = parsed.data.code;
      const configError = await validateRoleConfiguration(targetCode, permissions, page_access);
      if (configError) {
        res.status(400).json({ success: false, error: configError });
        return;
      }

      const { data: createdRole, error: createError } = await supabase
        .from('system_roles')
        .insert({
          code: targetCode,
          name: parsed.data.name,
          description: parsed.data.description ?? sourceRole.description ?? null,
          permissions,
          level: parsed.data.level ?? sourceRole.level,
          is_active: parsed.data.is_active ?? true,
          is_system: false,
        })
        .select()
        .single();

      if (createError || !createdRole) {
        if (createError?.code === '23505') {
          res.status(409).json({ success: false, error: 'Роль с таким кодом уже существует' });
        } else {
          res.status(500).json({ success: false, error: createError?.message || 'Не удалось создать роль' });
        }
        return;
      }

      await persistAccessProfile(targetCode, createdRole.id, permissions, page_access);
      invalidateAccessControlCache();
      res.status(201).json({ success: true, data: createdRole });
    } catch (error) {
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Failed to clone role' });
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

    const permissions = parsed.data.permissions !== undefined
      ? normalizePermissions(parsed.data.permissions)
      : normalizePermissions(currentRole.permissions);

    const pageAccess = await loadRoleAccessModes(code);
    const configError = await validateRoleConfiguration(code, permissions, pageAccess);
    if (configError) {
      res.status(400).json({ success: false, error: configError });
      return;
    }

    if (parsed.data.is_active === false && currentRole.is_active) {
      try {
        await ensureCriticalAdminAccess({
          roleActiveByCode: { [code]: false },
        });
      } catch (error) {
        res.status(400).json({ success: false, error: error instanceof Error ? error.message : 'Невозможно деактивировать последнюю администраторскую роль' });
        return;
      }
    }

    const updates: Record<string, unknown> = {
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      level: parsed.data.level,
      permissions,
      updated_at: new Date().toISOString(),
    };

    if (parsed.data.is_active !== undefined) {
      updates.is_active = parsed.data.is_active;
    }

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

    invalidateAccessControlCache();
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

      const permissions = normalizePermissions(parsed.data.permissions);
      const page_access = Object.fromEntries(
        Object.entries(parsed.data.page_access || {}).map(([pageKey, mode]) => [pageKey, mode as AccessMode]),
      );

      const configError = await validateRoleConfiguration(code, permissions, page_access);
      if (configError) {
        res.status(400).json({ success: false, error: configError });
        return;
      }

      if (role.is_active) {
        try {
          await ensureCriticalAdminAccess({
            rolePageAccessByCode: { [code]: page_access },
          });
        } catch (error) {
          res.status(400).json({ success: false, error: error instanceof Error ? error.message : 'Нельзя снять последний критичный доступ администрирования' });
          return;
        }
      }

      await persistAccessProfile(code, role.id, permissions, page_access);
      invalidateAccessControlCache();
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Не удалось сохранить профиль доступа' });
    }
  },

  async deleteRole(req: AuthenticatedRequest, res: Response): Promise<void> {
    const { code } = req.params;
    const role = await loadRoleByCode(code);

    if (!role) {
      res.status(404).json({ success: false, error: 'Роль не найдена' });
      return;
    }

    if (role.is_system) {
      res.status(403).json({ success: false, error: 'Системную роль нельзя удалить' });
      return;
    }

    try {
      await ensureCriticalAdminAccess({
        removedRoleCodes: [code],
      });
    } catch (error) {
      res.status(400).json({ success: false, error: error instanceof Error ? error.message : 'Нельзя удалить последнюю администраторскую роль' });
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

    invalidateAccessControlCache();
    res.json({ success: true });
  },
};
