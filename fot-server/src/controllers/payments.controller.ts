import type { Response } from 'express';
import { supabase } from '../config/database.js';
import type { AuthenticatedRequest } from '../types/index.js';

const PAYMENT_TYPES = ['salary', 'advance', 'bonus', 'vacation_pay', 'sick_pay', 'other'] as const;

/** Мои выплаты (worker) */
const getMy = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const employeeId = req.user.employee_id;
    if (!employeeId) {
      res.json({ success: true, data: [] });
      return;
    }

    const { data, error } = await supabase
      .from('payments')
      .select('*')
      .eq('employee_id', employeeId)
      .order('payment_date', { ascending: false });

    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (err) {
    console.error('payments.getMy error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения выплат' });
  }
};

/** Выплаты сотрудника (hr/admin) */
const getByEmployee = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { empId } = req.params;

    const { data, error } = await supabase
      .from('payments')
      .select('*')
      .eq('employee_id', empId)
      .order('payment_date', { ascending: false });

    if (error) throw error;
    res.json({ success: true, data: data || [] });
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

    const { data, error } = await supabase
      .from('payments')
      .insert({
        organization_id: req.user.organization_id,
        employee_id,
        payment_date,
        amount,
        payment_type,
        description: description || null,
        period: period || null,
        created_by: req.user.id,
      })
      .select()
      .single();

    if (error) throw error;
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

    const records = items.map((item: { employee_id: number; payment_date: string; amount: number; payment_type: string; description?: string; period?: string }) => ({
      organization_id: req.user.organization_id,
      employee_id: item.employee_id,
      payment_date: item.payment_date,
      amount: item.amount,
      payment_type: item.payment_type,
      description: item.description || null,
      period: item.period || null,
      created_by: req.user.id,
    }));

    const { data, error } = await supabase
      .from('payments')
      .insert(records)
      .select();

    if (error) throw error;
    res.json({ success: true, data: { imported: (data || []).length } });
  } catch (err) {
    console.error('payments.importBatch error:', err);
    res.status(500).json({ success: false, error: 'Ошибка импорта выплат' });
  }
};

export const paymentsController = { getMy, getByEmployee, create, importBatch };
