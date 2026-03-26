import type { Response } from 'express';
import { supabase } from '../config/database.js';
import type { AuthenticatedRequest } from '../types/index.js';

/** Мои расчётные листки (worker) */
const getMy = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const employeeId = req.user.employee_id;
    if (!employeeId) {
      res.json({ success: true, data: [] });
      return;
    }

    const { data, error } = await supabase
      .from('payslips')
      .select('*')
      .eq('employee_id', employeeId)
      .order('period', { ascending: false });

    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (err) {
    console.error('payslips.getMy error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения расчётных листков' });
  }
};

/** Расчётные листки сотрудника (hr/admin) */
const getByEmployee = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { empId } = req.params;

    const { data, error } = await supabase
      .from('payslips')
      .select('*')
      .eq('employee_id', empId)
      .order('period', { ascending: false });

    if (error) throw error;
    res.json({ success: true, data: data || [] });
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

    const { data, error } = await supabase
      .from('payslips')
      .upsert({
        organization_id: req.user.organization_id,
        employee_id,
        period,
        gross_amount: gross_amount || null,
        net_amount: net_amount || null,
        deductions: deductions || null,
        details: details || null,
        document_id: document_id || null,
        created_by: req.user.id,
      }, { onConflict: 'employee_id,period' })
      .select()
      .single();

    if (error) throw error;
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

    const records = items.map((item: { employee_id: number; period: string; gross_amount?: number; net_amount?: number; deductions?: number }) => ({
      organization_id: req.user.organization_id,
      employee_id: item.employee_id,
      period: item.period,
      gross_amount: item.gross_amount || null,
      net_amount: item.net_amount || null,
      deductions: item.deductions || null,
      created_by: req.user.id,
    }));

    const { data, error } = await supabase
      .from('payslips')
      .upsert(records, { onConflict: 'employee_id,period' })
      .select();

    if (error) throw error;
    res.json({ success: true, data: { imported: (data || []).length } });
  } catch (err) {
    console.error('payslips.importBatch error:', err);
    res.status(500).json({ success: false, error: 'Ошибка импорта расчётных листков' });
  }
};

export const payslipsController = { getMy, getByEmployee, create, importBatch };
