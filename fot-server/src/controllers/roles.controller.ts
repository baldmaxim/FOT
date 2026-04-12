import { Response } from 'express';
import { z } from 'zod';
import { supabase } from '../config/database.js';
import {
  AVAILABLE_PAGES,
  PAGE_ACCESS_KEYS,
  PERMISSION_GROUPS,
  normalizePageAccessEntry,
  normalizePermissions,
  validateRoleConfiguration,
} from '../config/access-control.js';
import type { AuthenticatedRequest } from '../types/index.js';
import { invalidateAccessControlCache } from '../services/access-control.service.js';

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

const pageAccessItemSchema = z.object({
  role_code: z.string().min(1),
  page_path: z.string().min(1),
  can_view: z.boolean(),
  can_edit: z.boolean().optional().default(false),
});

async function loadRoleIdByCode(): Promise<Map<string, string>> {
  const { data, error } = await supabase
    .from('system_roles')
    .select('id, code');

  if (error) {
    throw new Error(error.message);
  }

  return new Map((data || []).map(role => [role.code, role.id]));
}

async function loadPageAccessMatrix(): Promise<Record<string, Record<string, { can_view: boolean; can_edit: boolean }>>> {
  const { data, error } = await supabase
    .from('role_page_access')
    .select('role_code, system_role_id, page_path, can_view, can_edit');

  if (error) {
    throw new Error(error.message);
  }

  const matrix: Record<string, Record<string, { can_view: boolean; can_edit: boolean }>> = {};
  for (const entry of data || []) {
    if (!matrix[entry.role_code]) {
      matrix[entry.role_code] = {};
    }
    matrix[entry.role_code][entry.page_path] = {
      can_view: !!entry.can_view || !!entry.can_edit,
      can_edit: !!entry.can_edit,
    };
  }

  return matrix;
}

function validatePageAccessItems(items: { role_code: string; page_path: string; can_view: boolean; can_edit: boolean }[]): string | null {
  const invalidPage = items.find(item => !PAGE_ACCESS_KEYS.has(item.page_path));
  if (invalidPage) {
    return `Неизвестная страница в матрице доступа: ${invalidPage.page_path}`;
  }
  return null;
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

  async getPermissionCatalog(_req: AuthenticatedRequest, res: Response): Promise<void> {
    res.json({ success: true, data: PERMISSION_GROUPS });
  },

  async createRole(req: AuthenticatedRequest, res: Response): Promise<void> {
    const parsed = createRoleSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: parsed.error.errors[0].message });
      return;
    }

    const { code, name, description, level } = parsed.data;
    const permissions = normalizePermissions(parsed.data.permissions);
    const configError = validateRoleConfiguration(code, permissions, {});
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

  async updateRole(req: AuthenticatedRequest, res: Response): Promise<void> {
    const { code } = req.params;
    const parsed = updateRoleSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: parsed.error.errors[0].message });
      return;
    }

    const { data: currentRole, error: fetchError } = await supabase
      .from('system_roles')
      .select('permissions')
      .eq('code', code)
      .single();

    if (fetchError || !currentRole) {
      res.status(404).json({ success: false, error: 'Роль не найдена' });
      return;
    }

    const permissions = parsed.data.permissions !== undefined
      ? normalizePermissions(parsed.data.permissions)
      : normalizePermissions(currentRole.permissions);

    const pageAccessMatrix = await loadPageAccessMatrix();
    const configError = validateRoleConfiguration(code, permissions, pageAccessMatrix[code] ?? {});
    if (configError) {
      res.status(400).json({ success: false, error: configError });
      return;
    }

    const updates: Record<string, unknown> = {
      name: parsed.data.name,
      level: parsed.data.level,
      permissions,
      updated_at: new Date().toISOString(),
    };
    if (parsed.data.description !== undefined) updates.description = parsed.data.description;
    if (parsed.data.is_active !== undefined) updates.is_active = parsed.data.is_active;

    const { data, error } = await supabase
      .from('system_roles')
      .update(updates)
      .eq('code', code)
      .select()
      .single();

    if (error) {
      res.status(500).json({ success: false, error: error.message });
      return;
    }
    if (!data) {
      res.status(404).json({ success: false, error: 'Роль не найдена' });
      return;
    }

    invalidateAccessControlCache();
    res.json({ success: true, data });
  },

  async deleteRole(req: AuthenticatedRequest, res: Response): Promise<void> {
    const { code } = req.params;

    const { data: role, error: fetchError } = await supabase
      .from('system_roles')
      .select('is_system')
      .eq('code', code)
      .single();

    if (fetchError || !role) {
      res.status(404).json({ success: false, error: 'Роль не найдена' });
      return;
    }

    if (role.is_system) {
      res.status(403).json({ success: false, error: 'Системную роль нельзя удалить' });
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

  async getPageAccess(_req: AuthenticatedRequest, res: Response): Promise<void> {
    const { data, error } = await supabase
      .from('role_page_access')
      .select('*')
      .order('role_code', { ascending: true })
      .order('page_path', { ascending: true });

    if (error) {
      res.status(500).json({ success: false, error: error.message });
      return;
    }

    res.json({ success: true, data });
  },

  async updatePageAccess(req: AuthenticatedRequest, res: Response): Promise<void> {
    const parsed = z.array(pageAccessItemSchema).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'Неверный формат данных' });
      return;
    }

    const items = parsed.data.map(item => normalizePageAccessEntry({
      role_code: item.role_code,
      page_path: item.page_path,
      can_view: item.can_view,
      can_edit: item.can_edit ?? false,
    }));

    const itemValidationError = validatePageAccessItems(items);
    if (itemValidationError) {
      res.status(400).json({ success: false, error: itemValidationError });
      return;
    }

    let roleIdByCode: Map<string, string>;
    try {
      roleIdByCode = await loadRoleIdByCode();
    } catch (error) {
      res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Failed to load roles' });
      return;
    }

    const unmappedRole = items.find(item => !roleIdByCode.has(item.role_code));
    if (unmappedRole) {
      res.status(400).json({ success: false, error: `Неизвестная роль в матрице доступа: ${unmappedRole.role_code}` });
      return;
    }

    const currentMatrix = await loadPageAccessMatrix();
    for (const item of items) {
      if (!currentMatrix[item.role_code]) {
        currentMatrix[item.role_code] = {};
      }
      currentMatrix[item.role_code][item.page_path] = {
        can_view: item.can_view,
        can_edit: item.can_edit,
      };
    }

    const { data: roles, error: rolesError } = await supabase
      .from('system_roles')
      .select('code, permissions');

    if (rolesError) {
      res.status(500).json({ success: false, error: rolesError.message });
      return;
    }

    for (const role of roles || []) {
      const configError = validateRoleConfiguration(
        role.code,
        role.permissions,
        currentMatrix[role.code] ?? {},
      );
      if (configError) {
        res.status(400).json({ success: false, error: configError });
        return;
      }
    }

    const { error } = await supabase
      .from('role_page_access')
      .upsert(
        items.map(item => ({
          ...item,
          system_role_id: roleIdByCode.get(item.role_code) ?? null,
        })),
        { onConflict: 'system_role_id,page_path' },
      );

    if (error) {
      res.status(500).json({ success: false, error: error.message });
      return;
    }

    invalidateAccessControlCache();
    res.json({ success: true });
  },

  async getAvailablePages(_req: AuthenticatedRequest, res: Response): Promise<void> {
    res.json({ success: true, data: AVAILABLE_PAGES });
  },
};
