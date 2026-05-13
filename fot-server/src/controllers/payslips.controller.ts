import type { Response } from 'express';
import { query, queryOne } from '../config/postgres.js';
import type { AuthenticatedRequest } from '../types/index.js';
import { generatePayslipsForMonth } from '../services/payslip-generation.service.js';
import { canAccessEmployeeInScope } from '../services/data-scope.service.js';

const PAYSLIP_COLUMNS =
  'id, employee_id, period, gross_amount, net_amount, deductions, details, document_id, created_by, created_at';

/** Мои расчётные листки (worker) */
const getMy = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const employeeId = req.user.employee_id;
    if (!employeeId) {
      res.json({ success: true, data: [] });
      return;
    }

    const data = await query(
      `SELECT ${PAYSLIP_COLUMNS}
         FROM payslips
        WHERE employee_id = $1
        ORDER BY period DESC`,
      [employeeId],
    );
    res.json({ success: true, data });
  } catch (err) {
    console.error('payslips.getMy error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения расчётных листков' });
  }
};

/** Расчётные листки сотрудника (hr/admin) */
const getByEmployee = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { empId } = req.params;
    const employeeId = Number(empId);
    if (!Number.isInteger(employeeId) || !(await canAccessEmployeeInScope(req, employeeId))) {
      res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      return;
    }

    const data = await query(
      `SELECT ${PAYSLIP_COLUMNS}
         FROM payslips
        WHERE employee_id = $1
        ORDER BY period DESC`,
      [employeeId],
    );
    res.json({ success: true, data });
  } catch (err) {
    console.error('payslips.getByEmployee error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения расчётных листков' });
  }
};

/** Создание расчётного листка (hr/admin) */
const create = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { employee_id, period, gross_amount, net_amount, deductions, details, document_id } = req.body;
    if (!employee_id || !period) {
      res.status(400).json({ success: false, error: 'employee_id и period обязательны' });
      return;
    }
    if (!(await canAccessEmployeeInScope(req, Number(employee_id)))) {
      res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      return;
    }

    const data = await queryOne(
      `INSERT INTO payslips
         (employee_id, period, gross_amount, net_amount, deductions, details, document_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
       ON CONFLICT (employee_id, period) DO UPDATE SET
         gross_amount = EXCLUDED.gross_amount,
         net_amount = EXCLUDED.net_amount,
         deductions = EXCLUDED.deductions,
         details = EXCLUDED.details,
         document_id = EXCLUDED.document_id,
         created_by = EXCLUDED.created_by
       RETURNING *`,
      [
        employee_id,
        period,
        gross_amount || null,
        net_amount || null,
        deductions || null,
        details ? JSON.stringify(details) : null,
        document_id || null,
        req.user.id,
      ],
    );
    res.json({ success: true, data });
  } catch (err) {
    console.error('payslips.create error:', err);
    res.status(500).json({ success: false, error: 'Ошибка создания расчётного листка' });
  }
};

/** Массовый импорт расчётных листков из JSON (hr/admin) */
const importBatch = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      res.status(400).json({ success: false, error: 'items должен быть непустым массивом' });
      return;
    }
    for (const item of items) {
      if (!(await canAccessEmployeeInScope(req, Number(item.employee_id)))) {
        res.status(403).json({ success: false, error: 'Нет доступа к одному из сотрудников в batch' });
        return;
      }
    }

    type Item = {
      employee_id: number;
      period: string;
      gross_amount?: number;
      net_amount?: number;
      deductions?: number;
    };
    const list = items as Item[];

    let imported = 0;
    for (const item of list) {
      await queryOne(
        `INSERT INTO payslips
           (employee_id, period, gross_amount, net_amount, deductions, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (employee_id, period) DO UPDATE SET
           gross_amount = EXCLUDED.gross_amount,
           net_amount = EXCLUDED.net_amount,
           deductions = EXCLUDED.deductions,
           created_by = EXCLUDED.created_by
         RETURNING id`,
        [
          item.employee_id,
          item.period,
          item.gross_amount || null,
          item.net_amount || null,
          item.deductions || null,
          req.user.id,
        ],
      );
      imported += 1;
    }

    res.json({ success: true, data: { imported } });
  } catch (err) {
    console.error('payslips.importBatch error:', err);
    res.status(500).json({ success: false, error: 'Ошибка импорта расчётных листков' });
  }
};

/** Авто-генерация расчётных листков из табеля (admin+) */
const generate = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { year, month, department_id } = req.body;
    if (!year || !month) {
      res.status(400).json({ success: false, error: 'year и month обязательны' });
      return;
    }

    const result = await generatePayslipsForMonth(Number(year), Number(month), req.user.id, department_id || undefined);
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('payslips.generate error:', err);
    res.status(500).json({ success: false, error: 'Ошибка генерации расчётных листков' });
  }
};

export const payslipsController = { getMy, getByEmployee, create, importBatch, generate };
