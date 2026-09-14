/**
 * «Управление кадрами → Экспорт сотрудников»: xlsx, лист на раздел
 * (СМ, СУ-10, Бригады, Подрядные организации, Прочие) с умными таблицами.
 *
 * GET /api/employees/export — охват фиксирован (работающие + уволенные за
 * последние 30 дней в пределах прав пользователя), параметров нет.
 */
import { Response } from 'express';
import { withTransaction } from '../config/postgres.js';
import { auditService } from '../services/audit.service.js';
import { resolveEmployeeListScopeFilter } from '../services/employee-scope-filter.service.js';
import {
  buildExportSections,
  countSectionRows,
  EmployeesExportError,
  loadExportDepartments,
  loadExportEmployees,
  type IExportPeriod,
} from '../services/employees-export.service.js';
import { loadMainObjects } from '../services/employee-main-object-snapshot.service.js';
import { loadCostItems } from '../services/employee-cost-item.service.js';
import { buildEmployeesExportWorkbook } from '../services/employees-export-excel.service.js';
import { sanitizeExportFileName } from '../services/skud-export.service.js';
import { moscowTodayIso } from '../utils/date.utils.js';
import type { AuthenticatedRequest } from '../types/index.js';

/** Длина периода выгрузки в календарных днях, включая сегодня. */
export const EXPORT_PERIOD_DAYS = 30;

/** Период [сегодня − 29; сегодня] по московскому календарю. */
export function resolveExportPeriod(now: Date = new Date()): IExportPeriod {
  const end = moscowTodayIso(now);
  const startDate = new Date(`${end}T00:00:00Z`);
  startDate.setUTCDate(startDate.getUTCDate() - (EXPORT_PERIOD_DAYS - 1));
  return { start: startDate.toISOString().slice(0, 10), end };
}

function formatFileStamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`;
}

export const employeesExportController = {
  async exportEmployees(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const period = resolveExportPeriod();
      const scope = await resolveEmployeeListScopeFilter(req);
      const employees = await loadExportEmployees(scope, period);

      if (employees.length === 0) {
        res.status(400).json({
          success: false,
          error: 'Сотрудников для выгрузки не найдено',
          code: 'NO_DATA',
        });
        return;
      }

      const employeeIds = employees.map(employee => employee.id);
      const [departments, mainObjects] = await Promise.all([
        loadExportDepartments(),
        loadMainObjects(employeeIds, period),
      ]);
      // Та же функция и тот же источник объектов, что у столбца «Статья затрат» в таблице.
      const costItems = await loadCostItems(employeeIds, mainObjects.objectNamesByEmployee);
      const sections = buildExportSections({
        employees,
        departments,
        mainObjectByEmployee: mainObjects.objects,
        costItemByEmployee: costItems,
      });
      const total = countSectionRows(sections);

      const generatedAt = new Date();
      const workbook = buildEmployeesExportWorkbook(sections, {
        period,
        objectPeriod: mainObjects.period,
        generatedAt,
      });
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
          {
            details: {
              count: total,
              sections: Object.fromEntries(sections.map(section => [section.key, section.rows.length])),
              period,
              object_period: mainObjects.period,
              object_source: mainObjects.source,
              scope: scope.mode,
            },
          },
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
