import { Response } from 'express';
import { supabase } from '../config/database.js';
import { encryptionService } from '../services/encryption.service.js';
import { auditService } from '../services/audit.service.js';
import { safeDecrypt } from '../utils/crypto.utils.js';
import type {
  AuthenticatedRequest,
  OrgCompany,
  OrgCompanyEncrypted,
  OrgDepartment,
  OrgDepartmentEncrypted,
  OrgSubdivision,
  OrgSubdivisionEncrypted,
  OrgStructureTree,
} from '../types/index.js';

/**
 * Расшифровка компании
 */
function decryptCompany(encrypted: OrgCompanyEncrypted): OrgCompany {
  return {
    id: encrypted.id,
    organization_id: encrypted.organization_id,
    name: encryptionService.decrypt(encrypted.name_encrypted),
    description: safeDecrypt(encrypted.description_encrypted),
    sort_order: encrypted.sort_order,
    is_active: encrypted.is_active,
    created_at: encrypted.created_at,
    updated_at: encrypted.updated_at,
  };
}

/**
 * Расшифровка отдела
 */
function decryptDepartment(encrypted: OrgDepartmentEncrypted): OrgDepartment {
  return {
    id: encrypted.id,
    organization_id: encrypted.organization_id,
    company_id: encrypted.company_id,
    name: encryptionService.decrypt(encrypted.name_encrypted),
    description: safeDecrypt(encrypted.description_encrypted),
    sort_order: encrypted.sort_order,
    is_active: encrypted.is_active,
    created_at: encrypted.created_at,
    updated_at: encrypted.updated_at,
  };
}

/**
 * Расшифровка подразделения
 */
function decryptSubdivision(encrypted: OrgSubdivisionEncrypted): OrgSubdivision {
  return {
    id: encrypted.id,
    organization_id: encrypted.organization_id,
    department_id: encrypted.department_id,
    name: encryptionService.decrypt(encrypted.name_encrypted),
    description: safeDecrypt(encrypted.description_encrypted),
    sort_order: encrypted.sort_order,
    is_active: encrypted.is_active,
    created_at: encrypted.created_at,
    updated_at: encrypted.updated_at,
  };
}

export const structureController = {
  /**
   * GET /api/structure
   * Получение полного дерева структуры организации
   */
  async getTree(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const organizationId = req.user.organization_id;

      if (!organizationId) {
        res.status(400).json({ success: false, error: 'Организация не указана' });
        return;
      }

      // Получаем все данные параллельно
      const [companiesRes, departmentsRes, subdivisionsRes] = await Promise.all([
        supabase
          .from('org_companies')
          .select('*')
          .eq('organization_id', organizationId)
          .eq('is_active', true)
          .order('sort_order'),
        supabase
          .from('org_departments')
          .select('*')
          .eq('organization_id', organizationId)
          .eq('is_active', true)
          .order('sort_order'),
        supabase
          .from('org_subdivisions')
          .select('*')
          .eq('organization_id', organizationId)
          .eq('is_active', true)
          .order('sort_order'),
      ]);

      if (companiesRes.error || departmentsRes.error || subdivisionsRes.error) {
        console.error('Get structure error:', companiesRes.error || departmentsRes.error || subdivisionsRes.error);
        res.status(500).json({ success: false, error: 'Ошибка получения структуры' });
        return;
      }

      // Расшифровываем данные
      const companies = ((companiesRes.data || []) as OrgCompanyEncrypted[]).map(decryptCompany);
      const departments = ((departmentsRes.data || []) as OrgDepartmentEncrypted[]).map(decryptDepartment);
      const subdivisions = ((subdivisionsRes.data || []) as OrgSubdivisionEncrypted[]).map(decryptSubdivision);

      // Строим дерево
      const tree: OrgStructureTree = {
        companies: companies.map((company) => ({
          ...company,
          departments: departments
            .filter((dept) => dept.company_id === company.id)
            .map((dept) => ({
              ...dept,
              subdivisions: subdivisions.filter((sub) => sub.department_id === dept.id),
            })),
        })),
      };

      // Добавляем отделы без компании (на верхнем уровне)
      const orphanDepartments = departments
        .filter((dept) => !dept.company_id)
        .map((dept) => ({
          ...dept,
          subdivisions: subdivisions.filter((sub) => sub.department_id === dept.id),
        }));

      res.json({
        success: true,
        data: {
          tree,
          orphanDepartments,
          stats: {
            companies: companies.length,
            departments: departments.length,
            subdivisions: subdivisions.length,
          },
        },
      });
    } catch (error) {
      console.error('Get structure error:', error);
      res.status(500).json({ success: false, error: 'Ошибка получения структуры' });
    }
  },

  /**
   * POST /api/structure/companies
   * Создание компании
   */
  async createCompany(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const organizationId = req.user.organization_id;
      const { name, description } = req.body;

      if (!organizationId) {
        res.status(400).json({ success: false, error: 'Организация не указана' });
        return;
      }

      if (!name || name.trim().length < 1) {
        res.status(400).json({ success: false, error: 'Название обязательно' });
        return;
      }

      const { data, error } = await supabase
        .from('org_companies')
        .insert({
          organization_id: organizationId,
          name_encrypted: encryptionService.encrypt(name.trim()),
          description_encrypted: description ? encryptionService.encrypt(description.trim()) : null,
        })
        .select()
        .single();

      if (error) {
        console.error('Create company error:', error);
        res.status(500).json({ success: false, error: 'Ошибка создания компании' });
        return;
      }

      await auditService.logFromRequest(req, req.user.id, 'CREATE_ORG_COMPANY', {
        entityType: 'org_company',
        entityId: data.id,
      });

      res.status(201).json({ success: true, data: decryptCompany(data as OrgCompanyEncrypted) });
    } catch (error) {
      console.error('Create company error:', error);
      res.status(500).json({ success: false, error: 'Ошибка создания компании' });
    }
  },

  /**
   * POST /api/structure/departments
   * Создание отдела
   */
  async createDepartment(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const organizationId = req.user.organization_id;
      const { name, description, company_id } = req.body;

      if (!organizationId) {
        res.status(400).json({ success: false, error: 'Организация не указана' });
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
          company_id: company_id || null,
          name_encrypted: encryptionService.encrypt(name.trim()),
          description_encrypted: description ? encryptionService.encrypt(description.trim()) : null,
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
   * POST /api/structure/subdivisions
   * Создание подразделения
   */
  async createSubdivision(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const organizationId = req.user.organization_id;
      const { name, description, department_id } = req.body;

      if (!organizationId) {
        res.status(400).json({ success: false, error: 'Организация не указана' });
        return;
      }

      if (!name || name.trim().length < 1) {
        res.status(400).json({ success: false, error: 'Название обязательно' });
        return;
      }

      const { data, error } = await supabase
        .from('org_subdivisions')
        .insert({
          organization_id: organizationId,
          department_id: department_id || null,
          name_encrypted: encryptionService.encrypt(name.trim()),
          description_encrypted: description ? encryptionService.encrypt(description.trim()) : null,
        })
        .select()
        .single();

      if (error) {
        console.error('Create subdivision error:', error);
        res.status(500).json({ success: false, error: 'Ошибка создания подразделения' });
        return;
      }

      await auditService.logFromRequest(req, req.user.id, 'CREATE_ORG_SUBDIVISION', {
        entityType: 'org_subdivision',
        entityId: data.id,
      });

      res.status(201).json({ success: true, data: decryptSubdivision(data as OrgSubdivisionEncrypted) });
    } catch (error) {
      console.error('Create subdivision error:', error);
      res.status(500).json({ success: false, error: 'Ошибка создания подразделения' });
    }
  },

  /**
   * DELETE /api/structure/companies/:id
   */
  async deleteCompany(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const organizationId = req.user.organization_id;
      const { id } = req.params;

      const { error } = await supabase
        .from('org_companies')
        .delete()
        .eq('id', id)
        .eq('organization_id', organizationId);

      if (error) {
        console.error('Delete company error:', error);
        res.status(500).json({ success: false, error: 'Ошибка удаления компании' });
        return;
      }

      await auditService.logFromRequest(req, req.user.id, 'DELETE_ORG_COMPANY', {
        entityType: 'org_company',
        entityId: id,
      });

      res.json({ success: true, message: 'Компания удалена' });
    } catch (error) {
      console.error('Delete company error:', error);
      res.status(500).json({ success: false, error: 'Ошибка удаления компании' });
    }
  },

  /**
   * DELETE /api/structure/departments/:id
   */
  async deleteDepartment(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const organizationId = req.user.organization_id;
      const { id } = req.params;

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
   * DELETE /api/structure/subdivisions/:id
   */
  async deleteSubdivision(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const organizationId = req.user.organization_id;
      const { id } = req.params;

      const { error } = await supabase
        .from('org_subdivisions')
        .delete()
        .eq('id', id)
        .eq('organization_id', organizationId);

      if (error) {
        console.error('Delete subdivision error:', error);
        res.status(500).json({ success: false, error: 'Ошибка удаления подразделения' });
        return;
      }

      await auditService.logFromRequest(req, req.user.id, 'DELETE_ORG_SUBDIVISION', {
        entityType: 'org_subdivision',
        entityId: id,
      });

      res.json({ success: true, message: 'Подразделение удалено' });
    } catch (error) {
      console.error('Delete subdivision error:', error);
      res.status(500).json({ success: false, error: 'Ошибка удаления подразделения' });
    }
  },

  /**
   * Внутренний метод: найти или создать компанию по имени
   */
  async findOrCreateCompany(organizationId: string, name: string): Promise<string | null> {
    if (!name || !name.trim()) return null;

    const trimmedName = name.trim();
    const encryptedName = encryptionService.encrypt(trimmedName);

    // Пытаемся найти существующую
    const { data: existing } = await supabase
      .from('org_companies')
      .select('id, name_encrypted')
      .eq('organization_id', organizationId)
      .eq('is_active', true);

    // Ищем по расшифрованному имени
    const found = (existing || []).find((c: { name_encrypted: string }) => {
      try {
        return encryptionService.decrypt(c.name_encrypted).toLowerCase() === trimmedName.toLowerCase();
      } catch {
        return false;
      }
    });

    if (found) {
      return found.id;
    }

    // Создаём новую
    const { data: created, error } = await supabase
      .from('org_companies')
      .insert({
        organization_id: organizationId,
        name_encrypted: encryptedName,
      })
      .select()
      .single();

    if (error) {
      console.error('Auto-create company error:', error);
      return null;
    }

    return created.id;
  },

  /**
   * Внутренний метод: найти или создать отдел по имени
   */
  async findOrCreateDepartment(
    organizationId: string,
    name: string,
    companyId: string | null
  ): Promise<string | null> {
    if (!name || !name.trim()) return null;

    const trimmedName = name.trim();
    const encryptedName = encryptionService.encrypt(trimmedName);

    // Пытаемся найти существующий
    let query = supabase
      .from('org_departments')
      .select('id, name_encrypted')
      .eq('organization_id', organizationId)
      .eq('is_active', true);

    if (companyId) {
      query = query.eq('company_id', companyId);
    } else {
      query = query.is('company_id', null);
    }

    const { data: existing } = await query;

    // Ищем по расшифрованному имени
    const found = (existing || []).find((d: { name_encrypted: string }) => {
      try {
        return encryptionService.decrypt(d.name_encrypted).toLowerCase() === trimmedName.toLowerCase();
      } catch {
        return false;
      }
    });

    if (found) {
      return found.id;
    }

    // Создаём новый
    const { data: created, error } = await supabase
      .from('org_departments')
      .insert({
        organization_id: organizationId,
        company_id: companyId,
        name_encrypted: encryptedName,
      })
      .select()
      .single();

    if (error) {
      console.error('Auto-create department error:', error);
      return null;
    }

    return created.id;
  },

  /**
   * Внутренний метод: найти или создать подразделение по имени
   */
  async findOrCreateSubdivision(
    organizationId: string,
    name: string,
    departmentId: string | null
  ): Promise<string | null> {
    if (!name || !name.trim()) return null;

    const trimmedName = name.trim();
    const encryptedName = encryptionService.encrypt(trimmedName);

    // Пытаемся найти существующее
    let query = supabase
      .from('org_subdivisions')
      .select('id, name_encrypted')
      .eq('organization_id', organizationId)
      .eq('is_active', true);

    if (departmentId) {
      query = query.eq('department_id', departmentId);
    } else {
      query = query.is('department_id', null);
    }

    const { data: existing } = await query;

    // Ищем по расшифрованному имени
    const found = (existing || []).find((s: { name_encrypted: string }) => {
      try {
        return encryptionService.decrypt(s.name_encrypted).toLowerCase() === trimmedName.toLowerCase();
      } catch {
        return false;
      }
    });

    if (found) {
      return found.id;
    }

    // Создаём новое
    const { data: created, error } = await supabase
      .from('org_subdivisions')
      .insert({
        organization_id: organizationId,
        department_id: departmentId,
        name_encrypted: encryptedName,
      })
      .select()
      .single();

    if (error) {
      console.error('Auto-create subdivision error:', error);
      return null;
    }

    return created.id;
  },
};
