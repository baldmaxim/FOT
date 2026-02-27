import { Response } from 'express';
import { supabase } from '../config/database.js';
import { auditService } from '../services/audit.service.js';
import { getOrgId } from '../utils/org.utils.js';
import type {
  AuthenticatedRequest,
  OrgDepartment,
  OrgDepartmentEncrypted,
  OrgDepartmentNode,
} from '../types/index.js';

/**
 * Расшифровка отдела
 */
function decryptDepartment(encrypted: OrgDepartmentEncrypted): OrgDepartment {
  return {
    id: encrypted.id,
    organization_id: encrypted.organization_id,
    parent_id: encrypted.parent_id,
    sigur_department_id: encrypted.sigur_department_id,
    name: encrypted.name || '',
    description: encrypted.description || null,
    sort_order: encrypted.sort_order,
    is_active: encrypted.is_active,
    created_at: encrypted.created_at,
    updated_at: encrypted.updated_at,
  };
}

/**
 * Рекурсивное построение дерева отделов
 */
function buildDepartmentTree(
  allDepts: OrgDepartment[],
  parentId: string | null,
): OrgDepartmentNode[] {
  return allDepts
    .filter(d => d.parent_id === parentId)
    .sort((a, b) => a.sort_order - b.sort_order)
    .map(dept => ({
      ...dept,
      children: buildDepartmentTree(allDepts, dept.id),
    }));
}

export const structureController = {
  /**
   * GET /api/structure
   * Получение полного дерева структуры организации
   */
  async getTree(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const organizationId = req.user.organization_id;

      let query = supabase
        .from('org_departments')
        .select('*')
        .eq('is_active', true)
        .order('sort_order');

      if (organizationId) {
        query = query.eq('organization_id', organizationId);
      }

      const { data: departmentsData, error } = await query;

      if (error) {
        console.error('Get structure error:', error);
        res.status(500).json({ success: false, error: 'Ошибка получения структуры' });
        return;
      }

      const departments = ((departmentsData || []) as OrgDepartmentEncrypted[]).map(decryptDepartment);

      // Строим рекурсивное дерево (корневые — parent_id = null)
      const departmentTree = buildDepartmentTree(departments, null);

      res.json({
        success: true,
        data: {
          departments: departmentTree,
          stats: {
            departments: departments.length,
          },
        },
      });
    } catch (error) {
      console.error('Get structure error:', error);
      res.status(500).json({ success: false, error: 'Ошибка получения структуры' });
    }
  },

  /**
   * POST /api/structure/departments
   * Создание отдела
   */
  async createDepartment(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const organizationId = getOrgId(req);
      const { name, description, parent_id } = req.body;

      if (!organizationId) {
        res.status(400).json({ success: false, error: 'Организация не указана. Super admin: передайте ?organization_id=uuid' });
        return;
      }

      if (!name || name.trim().length < 1) {
        res.status(400).json({ success: false, error: 'Название обязательно' });
        return;
      }

      const { data, error } = await supabase
        .from('org_departments')
        .insert({
          organization_id: organizationId,
          parent_id: parent_id || null,
          name: name.trim(),
          description: description ? description.trim() : null,
        })
        .select()
        .single();

      if (error) {
        console.error('Create department error:', error);
        res.status(500).json({ success: false, error: 'Ошибка создания отдела' });
        return;
      }

      await auditService.logFromRequest(req, req.user.id, 'CREATE_ORG_DEPARTMENT', {
        entityType: 'org_department',
        entityId: data.id,
      });

      res.status(201).json({ success: true, data: decryptDepartment(data as OrgDepartmentEncrypted) });
    } catch (error) {
      console.error('Create department error:', error);
      res.status(500).json({ success: false, error: 'Ошибка создания отдела' });
    }
  },

  /**
   * DELETE /api/structure/departments/:id
   */
  async deleteDepartment(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const organizationId = getOrgId(req);
      const { id } = req.params;

      if (!organizationId) {
        res.status(400).json({ success: false, error: 'Организация не указана. Super admin: передайте ?organization_id=uuid' });
        return;
      }

      const { error } = await supabase
        .from('org_departments')
        .delete()
        .eq('id', id)
        .eq('organization_id', organizationId);

      if (error) {
        console.error('Delete department error:', error);
        res.status(500).json({ success: false, error: 'Ошибка удаления отдела' });
        return;
      }

      await auditService.logFromRequest(req, req.user.id, 'DELETE_ORG_DEPARTMENT', {
        entityType: 'org_department',
        entityId: id,
      });

      res.json({ success: true, message: 'Отдел удалён' });
    } catch (error) {
      console.error('Delete department error:', error);
      res.status(500).json({ success: false, error: 'Ошибка удаления отдела' });
    }
  },

  /**
   * Внутренний метод: найти или создать отдел по имени
   */
  async findOrCreateDepartment(
    organizationId: string,
    name: string,
    parentId: string | null
  ): Promise<string | null> {
    if (!name || !name.trim()) return null;

    const trimmedName = name.trim();

    let query = supabase
      .from('org_departments')
      .select('id, name')
      .eq('organization_id', organizationId)
      .eq('is_active', true);

    if (parentId) {
      query = query.eq('parent_id', parentId);
    } else {
      query = query.is('parent_id', null);
    }

    const { data: existing } = await query;

    const found = (existing || []).find((d: { name: string }) => {
      return (d.name || '').toLowerCase() === trimmedName.toLowerCase();
    });

    if (found) {
      return found.id;
    }

    const { data: created, error } = await supabase
      .from('org_departments')
      .insert({
        organization_id: organizationId,
        parent_id: parentId,
        name: trimmedName,
      })
      .select()
      .single();

    if (error) {
      console.error('Auto-create department error:', error);
      return null;
    }

    return created.id;
  },
};
