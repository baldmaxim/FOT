/**
 * GET /api/employees/section-departments — id отделов каждого раздела «Управления кадрами»
 * (СУ-10 / СМ / Бригады / Подрядные организации) для каскадного фильтра «Раздел → Отделы».
 *
 * Классификация — createDepartmentPlacer, та же, что у фильтра списка (section=…) и листов
 * Excel-выгрузки, поэтому дерево отделов в шапке не расходится с результатом фильтра.
 * Скоуп не расширяет: отдаются только id, дерево на клиенте всё равно режется скоупом.
 */
import { Response } from 'express';
import {
  COMPANY_WITH_BRIGADES_KEYS,
  createDepartmentPlacer,
  FILTERABLE_SECTION_KEYS,
  loadExportDepartments,
  type ExportSectionKey,
} from '../services/employees-export.service.js';
import type { AuthenticatedRequest } from '../types/index.js';

export type SectionDepartmentIds = Partial<Record<ExportSectionKey, string[]>>;

export const employeesSectionDepartmentsController = {
  async getSectionDepartments(_req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const departments = await loadExportDepartments();
      const placer = createDepartmentPlacer(departments);
      const data: SectionDepartmentIds = {};
      for (const key of FILTERABLE_SECTION_KEYS) data[key] = [];
      for (const dept of departments) {
        const placement = placer.place(dept.id);
        // su10/sm — по компании (с бригадами); brigades — прежний бакет для старых клиентов.
        const companyBucket = COMPANY_WITH_BRIGADES_KEYS.includes(placement.company) ? data[placement.company] : undefined;
        companyBucket?.push(dept.id);
        if (placement.section !== placement.company || !companyBucket) data[placement.section]?.push(dept.id);
      }
      res.json({ success: true, data });
    } catch (error) {
      console.error('Get section departments error:', error);
      res.status(500).json({ success: false, error: 'Не удалось загрузить отделы разделов' });
    }
  },
};
