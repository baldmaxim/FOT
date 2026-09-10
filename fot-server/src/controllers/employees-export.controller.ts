/**
 * «Управление кадрами → Экспорт сотрудников»: xlsx со списком людей,
 * сгруппированным по иерархии подразделений.
 *
 * GET /api/employees/export — охват фиксирован (все не уволенные в пределах
 * прав пользователя), параметров нет: фильтры экрана на файл не влияют.
 */
import { Response } from 'express';
import { withTransaction } from '../config/postgres.js';
import { auditService } from '../services/audit.service.js';
import { resolveEmployeeListScopeFilter } from '../services/employee-scope-filter.service.js';
import {
  buildExportTree,
  countTreeEmployees,
  EmployeesExportError,
  loadExportDepartments,
  loadExportEmployees,
} from '../services/employees-export.service.js';
import { buildEmployeesExportWorkbook } from '../services/employees-export-excel.service.js';
import { sanitizeExportFileName } from '../services/skud-export.service.js';
import type { AuthenticatedRequest } from '../types/index.js';

function formatFileStamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`;
}

export const employeesExportController = {
  async exportEmployees(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const scope = await resolveEmployeeListScopeFilter(req);
      const employees = await loadExportEmployees(scope);

      if (employees.length === 0) {
        res.status(400).json({
          success: false,
          error: 'Сотрудников для выгрузки не найдено',
          code: 'NO_DATA',
        });
        return;
      }

      const departments = await loadExportDepartments();
      const roots = buildExportTree({
        employees,
        departments,
        scopeDepartmentIds: scope.departmentIds,
      });
      const total = countTreeEmployees(roots);

      const generatedAt = new Date();
      const workbook = buildEmployeesExportWorkbook(roots, { total, generatedAt });
      const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
      const fileName = sanitizeExportFileName(`Сотрудники_${formatFileStamp(generatedAt)}.xlsx`);

      // Строгий аудит: выгрузка ФИО всей организации без следа недопустима.
      // logFromRequest здесь не годится — log() глотает ошибку записи внутри себя,
      // поэтому пишем через logFromRequestWithClient, который её пробрасывает.
      await withTransaction(async client => {
        await auditService.logFromRequestWithClient(
          client,
          req,
          req.user.id,
          'EXPORT_EMPLOYEES',
          { details: { count: total, groups: roots.length, scope: scope.mode } },
        );
      });

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(fileName)}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      );
      res.send(buffer);
    } catch (error) {
      if (error instanceof EmployeesExportError) {
        res.status(400).json({ success: false, error: error.message, code: error.code });
        return;
      }
      console.error('Export employees error:', error);
      res.status(500).json({ success: false, error: 'Ошибка формирования выгрузки' });
    }
  },
};
