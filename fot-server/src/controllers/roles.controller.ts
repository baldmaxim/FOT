import { Response } from 'express';
import { z } from 'zod';
import { supabase } from '../config/database.js';
import type { AuthenticatedRequest } from '../types/index.js';
import { invalidateRolesCache } from '../services/roles-cache.service.js';

// Список доступных страниц системы (для матрицы доступа)
const AVAILABLE_PAGES = [
  { path: '/employee',        label: 'Личный кабинет сотрудника' },
  { path: '/dashboard',       label: 'Дашборд' },
  { path: '/my-employees',    label: 'Мои сотрудники' },
  { path: '/leave-requests',  label: 'Заявления' },
  { path: '/timesheet',       label: 'Табель' },
  { path: '/profile',         label: 'Профиль' },
  { path: '/timesheet-review',label: 'Проверка табелей' },
  { path: '/tender',          label: 'Сотрудники (список)' },
  { path: '/skud-raw',        label: 'СКУД — сырые данные' },
  { path: '/skud-db',         label: 'СКУД — база данных' },
  { path: '/discipline',      label: 'Дисциплина' },
  { path: '/skud-settings',   label: 'Настройки СКУД' },
  { path: '/admin/users',     label: 'Управление пользователями' },
  { path: '/admin/manage',    label: 'Управление структурой' },
  { path: '/admin/audit',     label: 'Аудит данных' },
  { path: '/admin/roles',     label: 'Управление ролями' },
];

const createRoleSchema = z.object({
  code: z.string().min(1).max(50).regex(/^[a-z_]+$/, 'Только строчные буквы и подчёркивание'),
  name: z.string().min(1).max(100),
  description: z.string().max(500).nullable().optional(),
  level: z.number().int().min(0).max(100),
});

const updateRoleSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).nullable().optional(),
  level: z.number().int().min(0).max(100),
  is_active: z.boolean().optional(),
});

const pageAccessItemSchema = z.object({
  role_code: z.string().min(1),
  page_path: z.string().min(1),
  can_view: z.boolean(),
  can_edit: z.boolean().optional().default(false),
});

export const rolesController = {
  // GET /api/roles
  async getRoles(req: AuthenticatedRequest, res: Response): Promise<void> {
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

  // POST /api/roles
  async createRole(req: AuthenticatedRequest, res: Response): Promise<void> {
    const parsed = createRoleSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: parsed.error.errors[0].message });
      return;
    }

    const { code, name, description, level } = parsed.data;

    const { data, error } = await supabase
      .from('system_roles')
      .insert({ code, name, description: description ?? null, permissions: [], level, is_active: true, is_system: false })
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

    invalidateRolesCache();
    res.status(201).json({ success: true, data });
  },

  // PUT /api/roles/:code
  async updateRole(req: AuthenticatedRequest, res: Response): Promise<void> {
    const { code } = req.params;

    const parsed = updateRoleSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: parsed.error.errors[0].message });
      return;
    }

    const updates: Record<string, unknown> = {
      name: parsed.data.name,
      level: parsed.data.level,
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

    invalidateRolesCache();
    res.json({ success: true, data });
  },

  // DELETE /api/roles/:code
  async deleteRole(req: AuthenticatedRequest, res: Response): Promise<void> {
    const { code } = req.params;

    // Проверяем что роль не системная
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

    invalidateRolesCache();
    res.json({ success: true });
  },

  // GET /api/roles/page-access
  async getPageAccess(req: AuthenticatedRequest, res: Response): Promise<void> {
    const { data, error } = await supabase
      .from('role_page_access')
      .select('*');

    if (error) {
      res.status(500).json({ success: false, error: error.message });
      return;
    }

    res.json({ success: true, data });
  },

  // PUT /api/roles/page-access
  async updatePageAccess(req: AuthenticatedRequest, res: Response): Promise<void> {
    const parsed = z.array(pageAccessItemSchema).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'Неверный формат данных' });
      return;
    }

    const items = parsed.data.map(item => ({
      role_code: item.role_code,
      page_path: item.page_path,
      can_view: item.can_view,
      can_edit: item.can_edit ?? false,
    }));

    const { error } = await supabase
      .from('role_page_access')
      .upsert(items, { onConflict: 'role_code,page_path' });

    if (error) {
      res.status(500).json({ success: false, error: error.message });
      return;
    }

    res.json({ success: true });
  },

  // GET /api/roles/available-pages
  async getAvailablePages(_req: AuthenticatedRequest, res: Response): Promise<void> {
    res.json({ success: true, data: AVAILABLE_PAGES });
  },
};
