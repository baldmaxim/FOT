import { Response } from 'express';
import * as XLSX from 'xlsx';
import { supabase } from '../config/database.js';
import { auditService } from '../services/audit.service.js';
import { structureController } from './structure.controller.js';
import { parseDate } from '../utils/date.utils.js';
import { parseFIO } from '../utils/fio.utils.js';
import { getOrgId } from '../utils/org.utils.js';
import type { AuthenticatedRequest } from '../types/index.js';

// Интерфейс для запроса с файлом
interface MulterRequest extends AuthenticatedRequest {
  file?: Express.Multer.File;
}

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

/**
 * POST /api/employees/import
 * Импорт сотрудников из Excel
 */
export async function importEmployees(req: MulterRequest, res: Response): Promise<void> {
  try {
    const organizationId = getOrgId(req);

    if (!organizationId) {
      res.status(400).json({ success: false, error: 'Organization required. Super admin: передайте ?organization_id=uuid' });
      return;
    }

    if (!req.file) {
      res.status(400).json({ success: false, error: 'File is required' });
      return;
    }

    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];

    const rows: (string | number | Date | null)[][] = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      raw: false,
      dateNF: 'yyyy-mm-dd',
    });

    if (rows.length === 0) {
      res.status(400).json({ success: false, error: 'Файл пуст' });
      return;
    }

    const startRow = isHeaderRow(rows[0]) ? 1 : 0;
    const dataRows = rows.slice(startRow);

    const errors: string[] = [];
    const employeesToInsert: Record<string, unknown>[] = [];
    const departmentCache = new Map<string, string>();

    for (let i = 0; i < dataRows.length; i++) {
      const row = dataRows[i];
      const rowNum = startRow + i + 1;

      if (!row || row.length === 0 || !row[0]) continue;

      const fullName = String(row[0] || '').trim();
      const department = String(row[1] || '').trim() || null;
      const hireDateRaw = row[2];
      const birthDateRaw = row[3];
      const salaryRaw = row[4];
      const country = String(row[5] || '').trim() || null;
      const pensionNumber = String(row[6] || '').trim() || null;
      const patentIssueDateRaw = row[7];
      const patentExpiryDateRaw = row[8];
      const emailRaw = String(row[9] || '').trim() || null;

      const email = emailRaw && emailRaw.includes('@') ? emailRaw.toLowerCase() : null;

      if (!fullName || fullName.length < 2) {
        errors.push(`Строка ${rowNum}: некорректное ФИО`);
        continue;
      }

      const hireDate = parseDate(hireDateRaw);
      if (!hireDate) {
        errors.push(`Строка ${rowNum}: некорректная дата приёма`);
        continue;
      }

      const birthDate = parseDate(birthDateRaw);
      const patentIssueDate = parseDate(patentIssueDateRaw);
      const patentExpiryDate = parseDate(patentExpiryDateRaw);

      let salary: number | null = null;
      if (salaryRaw !== undefined && salaryRaw !== null && salaryRaw !== '') {
        const salaryStr = String(salaryRaw).replace(/[^\d.,]/g, '').replace(',', '.');
        const parsed = parseFloat(salaryStr);
        if (!isNaN(parsed) && parsed >= 0) salary = parsed;
      }

      let orgDepartmentId: string | null = null;
      if (department) {
        const cacheKey = department.toLowerCase();
        if (departmentCache.has(cacheKey)) {
          orgDepartmentId = departmentCache.get(cacheKey)!;
        } else {
          orgDepartmentId = await structureController.findOrCreateDepartment(organizationId, department, null);
          if (orgDepartmentId) departmentCache.set(cacheKey, orgDepartmentId);
        }
      }

      const fio = parseFIO(fullName);

      employeesToInsert.push({
        organization_id: organizationId,
        full_name: fullName,
        last_name: fio.lastName,
        first_name: fio.firstName || null,
        middle_name: fio.middleName || null,
        hire_date: hireDate,
        birth_date: birthDate || null,
        current_salary: salary,
        country: country || null,
        pension_number: pensionNumber || null,
        patent_issue_date: patentIssueDate || null,
        patent_expiry_date: patentExpiryDate || null,
        org_department_id: orgDepartmentId,
        email,
      });
    }

    if (employeesToInsert.length === 0) {
      res.status(400).json({ success: false, error: 'Нет данных для импорта', errors });
      return;
    }

    const { error: insertError } = await supabase.from('employees').insert(employeesToInsert);

    if (insertError) {
      console.error('Import insert error:', insertError);
      res.status(500).json({ success: false, error: 'Ошибка сохранения данных' });
      return;
    }

    await auditService.logFromRequest(req, req.user.id, 'IMPORT_EMPLOYEES', {
      details: { imported: employeesToInsert.length, errors: errors.length },
    });

    res.json({
      success: true,
      data: { imported: employeesToInsert.length, errors },
    });
  } catch (error) {
    console.error('Import employees error:', error);
    res.status(500).json({ success: false, error: 'Ошибка импорта' });
  }
}

/**
 * DELETE /api/employees/all
 */
export async function deleteAll(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const organizationId = getOrgId(req);

    if (!organizationId) {
      res.status(400).json({ success: false, error: 'Organization required. Super admin: передайте ?organization_id=uuid' });
      return;
    }

    const { count: beforeCount } = await supabase
      .from('employees')
      .select('*', { count: 'exact', head: true })
      .eq('organization_id', organizationId);

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
}
