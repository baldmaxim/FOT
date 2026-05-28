import type { Response } from 'express';
import { query, queryOne } from '../config/postgres.js';
import type { AuthenticatedRequest } from '../types/index.js';
import { canAccessEmployeeInScope } from '../services/data-scope.service.js';
import { emitDomainChange } from '../services/realtime-broadcast.service.js';
import { getEmployeeUserId, getUserIdsByEmployeeIds } from '../services/recipients.service.js';

const PAYMENT_TYPES = ['salary', 'advance', 'bonus', 'vacation_pay', 'sick_pay', 'other'] as const;

/** Мои выплаты (worker) */
const getMy = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const employeeId = req.user.employee_id;
    if (!employeeId) {
      res.json({ success: true, data: [] });
      return;
    }

    const data = await query(
      `SELECT * FROM payments
        WHERE employee_id = $1
        ORDER BY payment_date DESC`,
      [employeeId],
    );
    res.json({ success: true, data });
  } catch (err) {
    console.error('payments.getMy error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения выплат' });
  }
};

/** Выплаты сотрудника (hr/admin) */
const getByEmployee = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { empId } = req.params;
    const employeeId = Number(empId);
    if (!Number.isInteger(employeeId) || !(await canAccessEmployeeInScope(req, employeeId))) {
      res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      return;
    }

    const data = await query(
      `SELECT * FROM payments
        WHERE employee_id = $1
        ORDER BY payment_date DESC`,
      [employeeId],
    );
    res.json({ success: true, data });
  } catch (err) {
    console.error('payments.getByEmployee error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения выплат' });
  }
};

/** Создание выплаты (hr/admin) */
const create = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { employee_id, payment_date, amount, payment_type, description, period } = req.body;
    if (!employee_id || !payment_date || !amount || !payment_type) {
      res.status(400).json({ success: false, error: 'employee_id, payment_date, amount, payment_type обязательны' });
      return;
    }
    if (!PAYMENT_TYPES.includes(payment_type)) {
      res.status(400).json({ success: false, error: 'Недопустимый тип выплаты' });
      return;
    }
    if (!(await canAccessEmployeeInScope(req, Number(employee_id)))) {
      res.status(403).json({ success: false, error: 'Нет доступа к сотруднику' });
      return;
    }

    const data = await queryOne(
      `INSERT INTO payments
         (employee_id, payment_date, amount, payment_type, description, period, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        employee_id,
        payment_date,
        amount,
        payment_type,
        description || null,
        period || null,
        req.user.id,
      ],
    );

    getEmployeeUserId(Number(employee_id))
      .then((uid) => {
        if (uid) {
          emitDomainChange({
            event: 'payment:changed',
            targetUserIds: [uid],
            payload: { employeeId: Number(employee_id), action: 'create' },
          });
        }
      })
      .catch((e) => console.error('[payments] emit realtime error:', e));

    res.json({ success: true, data });
  } catch (err) {
    console.error('payments.create error:', err);
    res.status(500).json({ success: false, error: 'Ошибка создания выплаты' });
  }
};

/** Массовый импорт выплат (hr/admin) */
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
      payment_date: string;
      amount: number;
      payment_type: string;
      description?: string;
      period?: string;
    };
    const list = items as Item[];
    const empIds = list.map(it => it.employee_id);
    const dates = list.map(it => it.payment_date);
    const amounts = list.map(it => it.amount);
    const types = list.map(it => it.payment_type);
    const descriptions = list.map(it => it.description || null);
    const periods = list.map(it => it.period || null);
    const createdBy = req.user.id;

    const inserted = await query(
      `INSERT INTO payments
         (employee_id, payment_date, amount, payment_type, description, period, created_by)
       SELECT u.employee_id, u.payment_date, u.amount, u.payment_type, u.description, u.period, $7
         FROM unnest($1::bigint[], $2::date[], $3::numeric[], $4::text[], $5::text[], $6::text[])
           AS u(employee_id, payment_date, amount, payment_type, description, period)
       RETURNING id`,
      [empIds, dates, amounts, types, descriptions, periods, createdBy],
    );

    if (inserted.length > 0) {
      const uniqueEmpIds = [...new Set(empIds.filter((n) => Number.isFinite(n)))];
      getUserIdsByEmployeeIds(uniqueEmpIds)
        .then((userIds) => {
          if (userIds.length > 0) {
            emitDomainChange({
              event: 'payment:changed',
              targetUserIds: userIds,
              payload: { action: 'import' },
            });
          }
        })
        .catch((e) => console.error('[payments] emit batch realtime error:', e));
    }

    res.json({ success: true, data: { imported: inserted.length } });
  } catch (err) {
    console.error('payments.importBatch error:', err);
    res.status(500).json({ success: false, error: 'Ошибка импорта выплат' });
  }
};

export const paymentsController = { getMy, getByEmployee, create, importBatch };
