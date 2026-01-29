import { Response } from 'express';
import { z } from 'zod';
import * as XLSX from 'xlsx';
import { supabase } from '../config/database.js';
import { encryptionService } from '../services/encryption.service.js';
import { auditService } from '../services/audit.service.js';
import { structureController } from './structure.controller.js';
import { safeDecrypt } from '../utils/crypto.utils.js';
import { parseDate, isValidDate, formatDateToISO } from '../utils/date.utils.js';
import type { AuthenticatedRequest, Employee, EmployeeEncrypted } from '../types/index.js';

// Интерфейс для запроса с файлом
interface MulterRequest extends AuthenticatedRequest {
  file?: Express.Multer.File;
}

// Схемы валидации
const createEmployeeSchema = z.object({
  full_name: z.string().min(2).max(255).trim(),
  position: z.string().min(2).max(255).trim(),
  hire_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  birth_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  current_salary: z.number().min(0).max(999999999).nullable().optional(),
  country: z.string().max(100).nullable().optional(),
  pension_number: z.string().max(50).nullable().optional(),
  patent_issue_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  patent_expiry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  email: z.string().email().nullable().optional(),
  // Структура через справочники
  org_company_id: z.string().uuid().nullable().optional(),
  org_department_id: z.string().uuid().nullable().optional(),
  org_subdivision_id: z.string().uuid().nullable().optional(),
});

const updateEmployeeSchema = createEmployeeSchema.partial();

// Кэш для расшифрованных названий структуры
interface StructureCache {
  companies: Map<string, string>;
  departments: Map<string, string>;
  subdivisions: Map<string, string>;
}

/**
 * Загружает кэш структуры организации (компании, отделы, подразделения)
 */
async function loadStructureCache(organizationId: string): Promise<StructureCache> {
  const cache: StructureCache = {
    companies: new Map(),
    departments: new Map(),
    subdivisions: new Map(),
  };

  const [companiesRes, departmentsRes, subdivisionsRes] = await Promise.all([
    supabase.from('org_companies').select('id, name_encrypted').eq('organization_id', organizationId),
    supabase.from('org_departments').select('id, name_encrypted').eq('organization_id', organizationId),
    supabase.from('org_subdivisions').select('id, name_encrypted').eq('organization_id', organizationId),
  ]);

  (companiesRes.data || []).forEach((c: { id: string; name_encrypted: string }) => {
    cache.companies.set(c.id, safeDecrypt(c.name_encrypted) || '');
  });

  (departmentsRes.data || []).forEach((d: { id: string; name_encrypted: string }) => {
    cache.departments.set(d.id, safeDecrypt(d.name_encrypted) || '');
  });

  (subdivisionsRes.data || []).forEach((s: { id: string; name_encrypted: string }) => {
    cache.subdivisions.set(s.id, safeDecrypt(s.name_encrypted) || '');
  });

  return cache;
}

/**
 * Расшифровывает сотрудника из БД формата в API формат
 */
function decryptEmployee(encrypted: EmployeeEncrypted, structureCache: StructureCache): Employee {
  return {
    id: encrypted.id,
    organization_id: encrypted.organization_id,
    full_name: encryptionService.decrypt(encrypted.full_name_encrypted),
    position: encryptionService.decrypt(encrypted.position_encrypted),
    current_salary: encrypted.current_salary_encrypted
      ? parseFloat(encryptionService.decrypt(encrypted.current_salary_encrypted))
      : null,
    birth_date: safeDecrypt(encrypted.birth_date_encrypted),
    hire_date: encryptionService.decrypt(encrypted.hire_date_encrypted),
    country: safeDecrypt(encrypted.country_encrypted),
    pension_number: safeDecrypt(encrypted.pension_number_encrypted),
    patent_issue_date: safeDecrypt(encrypted.patent_issue_date_encrypted),
    patent_expiry_date: safeDecrypt(encrypted.patent_expiry_date_encrypted),
    email: encrypted.email || null,
    // Структура из справочников
    company: encrypted.org_company_id ? structureCache.companies.get(encrypted.org_company_id) || null : null,
    department: encrypted.org_department_id ? structureCache.departments.get(encrypted.org_department_id) || null : null,
    subdivision: encrypted.org_subdivision_id ? structureCache.subdivisions.get(encrypted.org_subdivision_id) || null : null,
    org_company_id: encrypted.org_company_id,
    org_department_id: encrypted.org_department_id,
    org_subdivision_id: encrypted.org_subdivision_id,
    is_archived: encrypted.is_archived,
    archived_at: encrypted.archived_at,
    created_at: encrypted.created_at,
    updated_at: encrypted.updated_at,
  };
}

export const employeesController = {
  /**
   * GET /api/employees
   * Получение списка сотрудников
   */
  async getAll(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const showArchived = req.query.archived === 'true';
      const organizationId = req.user.organization_id;

      if (!organizationId) {
        res.status(400).json({ success: false, error: 'Organization required' });
        return;
      }

      // Загружаем сотрудников и кэш структуры параллельно
      const [employeesResult, structureCache] = await Promise.all([
        supabase
          .from('employees')
          .select('*')
          .eq('organization_id', organizationId)
          .eq('is_archived', showArchived)
          .order('id'),
        loadStructureCache(organizationId),
      ]);

      if (employeesResult.error) {
        console.error('Get employees error:', employeesResult.error);
        res.status(500).json({ success: false, error: 'Failed to fetch employees' });
        return;
      }

      // Расшифровываем данные
      const employees = (employeesResult.data as EmployeeEncrypted[]).map(
        (emp) => decryptEmployee(emp, structureCache)
      );

      await auditService.logFromRequest(req, req.user.id, 'VIEW_EMPLOYEES', {
        details: { count: employees.length, archived: showArchived },
      });

      res.json({ success: true, data: employees });
    } catch (error) {
      console.error('Get employees error:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch employees' });
    }
  },

  /**
   * GET /api/employees/:id
   * Получение одного сотрудника
   */
  async getById(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const organizationId = req.user.organization_id;

      if (!organizationId) {
        res.status(400).json({ success: false, error: 'Organization required' });
        return;
      }

      const [employeeResult, structureCache] = await Promise.all([
        supabase
          .from('employees')
          .select('*')
          .eq('id', id)
          .eq('organization_id', organizationId)
          .single(),
        loadStructureCache(organizationId),
      ]);

      if (employeeResult.error || !employeeResult.data) {
        res.status(404).json({ success: false, error: 'Employee not found' });
        return;
      }

      const employee = decryptEmployee(employeeResult.data as EmployeeEncrypted, structureCache);

      res.json({ success: true, data: employee });
    } catch (error) {
      console.error('Get employee error:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch employee' });
    }
  },

  /**
   * POST /api/employees
   * Создание сотрудника
   */
  async create(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const validated = createEmployeeSchema.parse(req.body);
      const organizationId = req.user.organization_id;

      if (!organizationId) {
        res.status(400).json({ success: false, error: 'Organization required' });
        return;
      }

      // Шифруем данные
      const encryptedData = {
        organization_id: organizationId,
        full_name_encrypted: encryptionService.encrypt(validated.full_name),
        position_encrypted: encryptionService.encrypt(validated.position),
        current_salary_encrypted: validated.current_salary
          ? encryptionService.encrypt(String(validated.current_salary))
          : null,
        birth_date_encrypted: validated.birth_date
          ? encryptionService.encrypt(validated.birth_date)
          : null,
        hire_date_encrypted: encryptionService.encrypt(validated.hire_date),
        country_encrypted: validated.country
          ? encryptionService.encrypt(validated.country)
          : null,
        pension_number_encrypted: validated.pension_number
          ? encryptionService.encrypt(validated.pension_number)
          : null,
        patent_issue_date_encrypted: validated.patent_issue_date
          ? encryptionService.encrypt(validated.patent_issue_date)
          : null,
        patent_expiry_date_encrypted: validated.patent_expiry_date
          ? encryptionService.encrypt(validated.patent_expiry_date)
          : null,
        email: validated.email || null,
        // Структура через справочники
        org_company_id: validated.org_company_id || null,
        org_department_id: validated.org_department_id || null,
        org_subdivision_id: validated.org_subdivision_id || null,
      };

      const { data, error } = await supabase
        .from('employees')
        .insert(encryptedData)
        .select()
        .single();

      if (error) {
        console.error('Create employee error:', error);
        res.status(500).json({ success: false, error: 'Failed to create employee' });
        return;
      }

      await auditService.logFromRequest(req, req.user.id, 'CREATE_EMPLOYEE', {
        entityType: 'employee',
        entityId: String(data.id),
      });

      // Возвращаем расшифрованные данные
      const structureCache = await loadStructureCache(organizationId);
      const employee = decryptEmployee(data as EmployeeEncrypted, structureCache);

      res.status(201).json({ success: true, data: employee });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('Create employee error:', error);
      res.status(500).json({ success: false, error: 'Failed to create employee' });
    }
  },

  /**
   * PUT /api/employees/:id
   * Обновление сотрудника
   */
  async update(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const validated = updateEmployeeSchema.parse(req.body);
      const organizationId = req.user.organization_id;

      if (!organizationId) {
        res.status(400).json({ success: false, error: 'Organization required' });
        return;
      }

      // Проверяем что сотрудник принадлежит организации
      const { data: existing } = await supabase
        .from('employees')
        .select('id')
        .eq('id', id)
        .eq('organization_id', organizationId)
        .single();

      if (!existing) {
        res.status(404).json({ success: false, error: 'Employee not found' });
        return;
      }

      // Формируем данные для обновления
      const updateData: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
      };

      if (validated.full_name !== undefined) {
        updateData.full_name_encrypted = encryptionService.encrypt(validated.full_name);
      }
      if (validated.position !== undefined) {
        updateData.position_encrypted = encryptionService.encrypt(validated.position);
      }
      if (validated.current_salary !== undefined) {
        updateData.current_salary_encrypted = validated.current_salary
          ? encryptionService.encrypt(String(validated.current_salary))
          : null;
      }
      if (validated.birth_date !== undefined) {
        updateData.birth_date_encrypted = validated.birth_date
          ? encryptionService.encrypt(validated.birth_date)
          : null;
      }
      if (validated.hire_date !== undefined) {
        updateData.hire_date_encrypted = encryptionService.encrypt(validated.hire_date);
      }
      if (validated.country !== undefined) {
        updateData.country_encrypted = validated.country
          ? encryptionService.encrypt(validated.country)
          : null;
      }
      if (validated.pension_number !== undefined) {
        updateData.pension_number_encrypted = validated.pension_number
          ? encryptionService.encrypt(validated.pension_number)
          : null;
      }
      if (validated.patent_issue_date !== undefined) {
        updateData.patent_issue_date_encrypted = validated.patent_issue_date
          ? encryptionService.encrypt(validated.patent_issue_date)
          : null;
      }
      if (validated.patent_expiry_date !== undefined) {
        updateData.patent_expiry_date_encrypted = validated.patent_expiry_date
          ? encryptionService.encrypt(validated.patent_expiry_date)
          : null;
      }
      if (validated.email !== undefined) {
        updateData.email = validated.email;
      }
      // Структура через справочники
      if (validated.org_company_id !== undefined) {
        updateData.org_company_id = validated.org_company_id;
      }
      if (validated.org_department_id !== undefined) {
        updateData.org_department_id = validated.org_department_id;
      }
      if (validated.org_subdivision_id !== undefined) {
        updateData.org_subdivision_id = validated.org_subdivision_id;
      }

      const { data, error } = await supabase
        .from('employees')
        .update(updateData)
        .eq('id', id)
        .select()
        .single();

      if (error) {
        console.error('Update employee error:', error);
        res.status(500).json({ success: false, error: 'Failed to update employee' });
        return;
      }

      await auditService.logFromRequest(req, req.user.id, 'UPDATE_EMPLOYEE', {
        entityType: 'employee',
        entityId: id,
        details: { updated_fields: Object.keys(validated) },
      });

      const structureCache = await loadStructureCache(organizationId);
      const employee = decryptEmployee(data as EmployeeEncrypted, structureCache);

      res.json({ success: true, data: employee });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('Update employee error:', error);
      res.status(500).json({ success: false, error: 'Failed to update employee' });
    }
  },

  /**
   * DELETE /api/employees/:id
   * Удаление сотрудника
   */
  async delete(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const organizationId = req.user.organization_id;

      if (!organizationId) {
        res.status(400).json({ success: false, error: 'Organization required' });
        return;
      }

      const { error } = await supabase
        .from('employees')
        .delete()
        .eq('id', id)
        .eq('organization_id', organizationId);

      if (error) {
        console.error('Delete employee error:', error);
        res.status(500).json({ success: false, error: 'Failed to delete employee' });
        return;
      }

      await auditService.logFromRequest(req, req.user.id, 'DELETE_EMPLOYEE', {
        entityType: 'employee',
        entityId: id,
      });

      res.json({ success: true, message: 'Employee deleted' });
    } catch (error) {
      console.error('Delete employee error:', error);
      res.status(500).json({ success: false, error: 'Failed to delete employee' });
    }
  },

  /**
   * POST /api/employees/:id/archive
   * Архивация сотрудника
   */
  async archive(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const organizationId = req.user.organization_id;

      if (!organizationId) {
        res.status(400).json({ success: false, error: 'Organization required' });
        return;
      }

      const { data, error } = await supabase
        .from('employees')
        .update({
          is_archived: true,
          archived_at: new Date().toISOString(),
        })
        .eq('id', id)
        .eq('organization_id', organizationId)
        .select()
        .single();

      if (error || !data) {
        res.status(404).json({ success: false, error: 'Employee not found' });
        return;
      }

      await auditService.logFromRequest(req, req.user.id, 'ARCHIVE_EMPLOYEE', {
        entityType: 'employee',
        entityId: id,
      });

      const structureCache = await loadStructureCache(organizationId);
      const employee = decryptEmployee(data as EmployeeEncrypted, structureCache);

      res.json({ success: true, data: employee });
    } catch (error) {
      console.error('Archive employee error:', error);
      res.status(500).json({ success: false, error: 'Failed to archive employee' });
    }
  },

  /**
   * POST /api/employees/:id/restore
   * Восстановление сотрудника из архива
   */
  async restore(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const organizationId = req.user.organization_id;

      if (!organizationId) {
        res.status(400).json({ success: false, error: 'Organization required' });
        return;
      }

      const { data, error } = await supabase
        .from('employees')
        .update({
          is_archived: false,
          archived_at: null,
        })
        .eq('id', id)
        .eq('organization_id', organizationId)
        .select()
        .single();

      if (error || !data) {
        res.status(404).json({ success: false, error: 'Employee not found' });
        return;
      }

      const structureCache = await loadStructureCache(organizationId);
      const employee = decryptEmployee(data as EmployeeEncrypted, structureCache);

      res.json({ success: true, data: employee });
    } catch (error) {
      console.error('Restore employee error:', error);
      res.status(500).json({ success: false, error: 'Failed to restore employee' });
    }
  },

  /**
   * DELETE /api/employees/all
   * Удаление ВСЕХ сотрудников (только для разработки)
   */
  async deleteAll(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const organizationId = req.user.organization_id;

      // Получаем количество для логирования
      const { count: beforeCount } = await supabase
        .from('employees')
        .select('*', { count: 'exact', head: true })
        .eq('organization_id', organizationId);

      // Удаляем всех сотрудников организации
      const { error } = await supabase
        .from('employees')
        .delete()
        .eq('organization_id', organizationId);

      if (error) {
        console.error('Delete all employees error:', error);
        res.status(500).json({ success: false, error: 'Failed to delete employees' });
        return;
      }

      await auditService.logFromRequest(req, req.user.id, 'DELETE_ALL_EMPLOYEES', {
        details: { deleted: beforeCount || 0 },
      });

      res.json({
        success: true,
        data: { deleted: beforeCount || 0 },
        message: `Удалено ${beforeCount || 0} сотрудников`,
      });
    } catch (error) {
      console.error('Delete all employees error:', error);
      res.status(500).json({ success: false, error: 'Failed to delete employees' });
    }
  },

  /**
   * POST /api/employees/import
   * Импорт сотрудников из Excel
   * Формат колонок:
   * 1-ФИО, 2-Должность, 3-Отдел, 4-Подразделение, 5-Дата приёма,
   * 6-Дата рождения, 7-ЗП, 8-Страна, 9-СНИЛС, 10-Дата выдачи патента, 11-Дата окончания патента, 12-Компания, 13-Email
   */
  async import(req: MulterRequest, res: Response): Promise<void> {
    try {
      const organizationId = req.user.organization_id;

      if (!organizationId) {
        res.status(400).json({ success: false, error: 'Organization required' });
        return;
      }

      if (!req.file) {
        res.status(400).json({ success: false, error: 'File is required' });
        return;
      }

      // Парсим Excel файл
      const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];

      // Преобразуем в массив массивов (каждая строка - массив ячеек)
      const rows: (string | number | Date | null)[][] = XLSX.utils.sheet_to_json(sheet, {
        header: 1,
        raw: false,
        dateNF: 'yyyy-mm-dd',
      });

      if (rows.length === 0) {
        res.status(400).json({ success: false, error: 'Файл пуст' });
        return;
      }

      // Пропускаем заголовок если первая строка выглядит как заголовок
      const startRow = isHeaderRow(rows[0]) ? 1 : 0;
      const dataRows = rows.slice(startRow);

      const errors: string[] = [];
      const employeesToInsert: {
        organization_id: string;
        full_name_encrypted: string;
        position_encrypted: string;
        hire_date_encrypted: string;
        birth_date_encrypted: string | null;
        current_salary_encrypted: string | null;
        country_encrypted: string | null;
        pension_number_encrypted: string | null;
        patent_issue_date_encrypted: string | null;
        patent_expiry_date_encrypted: string | null;
        // Только ссылки на справочники (без дублирования текста)
        org_company_id: string | null;
        org_department_id: string | null;
        org_subdivision_id: string | null;
        // Email (не шифруется - публичные данные)
        email: string | null;
      }[] = [];

      // Кэш для созданных структур (чтобы не создавать дубликаты)
      const companyCache = new Map<string, string>();
      const departmentCache = new Map<string, string>();
      const subdivisionCache = new Map<string, string>();

      for (let i = 0; i < dataRows.length; i++) {
        const row = dataRows[i];
        const rowNum = startRow + i + 1; // Номер строки в Excel (1-based)

        // Пропускаем пустые строки
        if (!row || row.length === 0 || !row[0]) {
          continue;
        }

        // Колонки по новому формату:
        // 0: ФИО, 1: Должность, 2: Отдел, 3: Подразделение, 4: Дата приёма
        // 5: Дата рождения, 6: ЗП, 7: Страна, 8: СНИЛС, 9: Дата выдачи патента, 10: Дата окончания патента, 11: Компания
        const fullName = String(row[0] || '').trim();
        const position = String(row[1] || '').trim() || 'Сотрудник';
        const department = String(row[2] || '').trim() || null;
        const subdivision = String(row[3] || '').trim() || null;
        const hireDateRaw = row[4];
        const birthDateRaw = row[5];
        const salaryRaw = row[6];
        const country = String(row[7] || '').trim() || null;
        const pensionNumber = String(row[8] || '').trim() || null;
        const patentIssueDateRaw = row[9];
        const patentExpiryDateRaw = row[10];
        const company = String(row[11] || '').trim() || null;
        const emailRaw = String(row[12] || '').trim() || null;

        // Валидация email (простая проверка)
        const email = emailRaw && emailRaw.includes('@') ? emailRaw.toLowerCase() : null;

        // Валидация ФИО
        if (!fullName || fullName.length < 2) {
          errors.push(`Строка ${rowNum}: некорректное ФИО`);
          continue;
        }

        // Парсинг и валидация даты устройства
        const hireDate = parseDate(hireDateRaw);
        if (!hireDate) {
          errors.push(`Строка ${rowNum}: некорректная дата приёма на работу`);
          continue;
        }

        // Парсинг опциональных дат
        const birthDate = parseDate(birthDateRaw);
        const patentIssueDate = parseDate(patentIssueDateRaw);
        const patentExpiryDate = parseDate(patentExpiryDateRaw);

        // Парсинг зарплаты
        let salary: number | null = null;
        if (salaryRaw !== undefined && salaryRaw !== null && salaryRaw !== '') {
          const salaryStr = String(salaryRaw).replace(/[^\d.,]/g, '').replace(',', '.');
          const parsed = parseFloat(salaryStr);
          if (!isNaN(parsed) && parsed >= 0) {
            salary = parsed;
          }
        }

        // Автоматическое создание структуры организации
        let orgCompanyId: string | null = null;
        let orgDepartmentId: string | null = null;
        let orgSubdivisionId: string | null = null;

        // 1. Создаём/находим компанию
        if (company) {
          const cacheKey = company.toLowerCase();
          if (companyCache.has(cacheKey)) {
            orgCompanyId = companyCache.get(cacheKey)!;
          } else {
            orgCompanyId = await structureController.findOrCreateCompany(organizationId, company);
            if (orgCompanyId) {
              companyCache.set(cacheKey, orgCompanyId);
            }
          }
        }

        // 2. Создаём/находим отдел (привязываем к компании если есть)
        if (department) {
          const cacheKey = `${orgCompanyId || 'null'}:${department.toLowerCase()}`;
          if (departmentCache.has(cacheKey)) {
            orgDepartmentId = departmentCache.get(cacheKey)!;
          } else {
            orgDepartmentId = await structureController.findOrCreateDepartment(organizationId, department, orgCompanyId);
            if (orgDepartmentId) {
              departmentCache.set(cacheKey, orgDepartmentId);
            }
          }
        }

        // 3. Создаём/находим подразделение (привязываем к отделу если есть)
        if (subdivision) {
          const cacheKey = `${orgDepartmentId || 'null'}:${subdivision.toLowerCase()}`;
          if (subdivisionCache.has(cacheKey)) {
            orgSubdivisionId = subdivisionCache.get(cacheKey)!;
          } else {
            orgSubdivisionId = await structureController.findOrCreateSubdivision(organizationId, subdivision, orgDepartmentId);
            if (orgSubdivisionId) {
              subdivisionCache.set(cacheKey, orgSubdivisionId);
            }
          }
        }

        // Добавляем сотрудника (только ссылки на справочники, без дублирования текста)
        employeesToInsert.push({
          organization_id: organizationId,
          full_name_encrypted: encryptionService.encrypt(fullName),
          position_encrypted: encryptionService.encrypt(position),
          hire_date_encrypted: encryptionService.encrypt(hireDate),
          birth_date_encrypted: birthDate ? encryptionService.encrypt(birthDate) : null,
          current_salary_encrypted: salary !== null ? encryptionService.encrypt(String(salary)) : null,
          country_encrypted: country ? encryptionService.encrypt(country) : null,
          pension_number_encrypted: pensionNumber ? encryptionService.encrypt(pensionNumber) : null,
          patent_issue_date_encrypted: patentIssueDate ? encryptionService.encrypt(patentIssueDate) : null,
          patent_expiry_date_encrypted: patentExpiryDate ? encryptionService.encrypt(patentExpiryDate) : null,
          // Структура через справочники
          org_company_id: orgCompanyId,
          org_department_id: orgDepartmentId,
          org_subdivision_id: orgSubdivisionId,
          // Email (не шифруется)
          email,
        });
      }

      if (employeesToInsert.length === 0) {
        res.status(400).json({
          success: false,
          error: 'Нет данных для импорта',
          errors,
        });
        return;
      }

      // Вставляем всех сотрудников
      const { error: insertError } = await supabase
        .from('employees')
        .insert(employeesToInsert);

      if (insertError) {
        console.error('Import insert error:', insertError);
        res.status(500).json({ success: false, error: 'Ошибка сохранения данных' });
        return;
      }

      await auditService.logFromRequest(req, req.user.id, 'IMPORT_EMPLOYEES', {
        details: {
          imported: employeesToInsert.length,
          errors: errors.length,
        },
      });

      res.json({
        success: true,
        data: {
          imported: employeesToInsert.length,
          errors,
        },
      });
    } catch (error) {
      console.error('Import employees error:', error);
      res.status(500).json({ success: false, error: 'Ошибка импорта' });
    }
  },
};

/**
 * Проверяет, является ли строка заголовком
 */
function isHeaderRow(row: (string | number | Date | null)[]): boolean {
  if (!row || row.length === 0) return false;
  const firstCell = String(row[0] || '').toLowerCase();
  return (
    firstCell.includes('фио') ||
    firstCell.includes('имя') ||
    firstCell.includes('name') ||
    firstCell === '№' ||
    firstCell === '#'
  );
}
