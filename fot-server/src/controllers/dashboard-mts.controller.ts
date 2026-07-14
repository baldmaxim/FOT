import type { Response } from 'express';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../types/index.js';
import {
  hasObjectViewScope,
  resolveAccessibleEmployeeIds,
  resolveScopedDepartmentId,
} from '../services/data-scope.service.js';
import { collectDeptIds } from '../services/skud-shared.service.js';
import { parseUsagePeriod } from '../services/mts-business-statement-rows.service.js';
import { mtsBusinessDeptUsageService } from '../services/mts-business-dept-usage.service.js';

// Вкладка «МТС» на дашборде руководителя: сводка связи по сотрудникам ЕГО отдела.
// Живёт вне /api/mts-business (тот закрыт ролями admin/mts_manager) — доступ здесь
// даёт страница /dashboard, а границу отдела ставит скоуп, как у dashboard-stats.

const querySchema = z.object({
  department_id: z.string().optional(),
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const currentMonth = (): string => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
};

export const dashboardMtsController = {
  /** GET /api/dashboard/mts-usage?department_id=uuid&month=YYYY-MM|date=YYYY-MM-DD */
  async getDepartmentMtsUsage(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const parsed = querySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: 'Некорректные параметры запроса',
          details: parsed.error.flatten(),
        });
        return;
      }

      const requestedDepartmentId = parsed.data.department_id ?? null;
      const departmentId = await resolveScopedDepartmentId(req, requestedDepartmentId);

      if (requestedDepartmentId && !departmentId) {
        res.status(403).json({
          success: false,
          error: 'Access denied to this department',
          code: 'DEPARTMENT_ACCESS_DENIED',
        });
        return;
      }
      if (!departmentId) {
        res.status(400).json({ success: false, error: 'department_id обязателен' });
        return;
      }

      const period = parseUsagePeriod(parsed.data.month ?? currentMonth(), parsed.data.date ?? '');
      if (!period) {
        res.status(400).json({ success: false, error: 'Укажите month=YYYY-MM или date=YYYY-MM-DD' });
        return;
      }

      // Объектный view-скоуп: сужаем сотрудников отдела до видимого набора (отделы ∩ объекты).
      let allowedEmployeeIds: number[] | null = null;
      if (await hasObjectViewScope(req)) {
        const accessible = await resolveAccessibleEmployeeIds(req);
        if (accessible !== 'all') allowedEmployeeIds = [...accessible];
      }

      // Поддерево — так же, как считает остальной дашборд (skud-dashboard.service),
      // иначе цифры вкладки разойдутся с цифрами «Обзора».
      const deptIds = await collectDeptIds(departmentId);
      const usage = await mtsBusinessDeptUsageService.getDepartmentUsageByEmployee(
        deptIds,
        period.dateFrom,
        period.dateTo,
        allowedEmployeeIds,
      );

      res.json({
        success: true,
        data: {
          period: period.period,
          dateFrom: period.dateFrom,
          dateTo: period.dateTo,
          departmentId,
          ...usage,
        },
      });
    } catch (error) {
      console.error('getDepartmentMtsUsage error:', error);
      res.status(500).json({ success: false, error: 'Ошибка получения статистики МТС по отделу' });
    }
  },
};
