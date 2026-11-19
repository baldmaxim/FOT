import type { NextFunction, Response } from 'express';

import {
  getRequestBrigadeOutputAccess,
  getRequestBrigadeSalaryLevel,
} from '../services/payroll/brigade-output-access.service.js';
import type { AuthenticatedRequest } from '../types/index.js';

/** Список «Зарплаты» или галочка «Выработка» (миграция 342); охват отдела и полный расчёт — в контроллере. */
export const requireBrigadeOutputAccess = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    if (!(await getRequestBrigadeOutputAccess(req))) {
      res.status(403).json({ success: false, error: 'Нет доступа к выработке бригад' });
      return;
    }
    next();
  } catch (err) {
    console.error('requireBrigadeOutputAccess error:', err);
    res.status(500).json({ success: false, error: 'Authorization check failed' });
  }
};

/**
 * Полный расчёт бригады и КТУ: то же, что выше, ИЛИ галочка начальника участка со своими бригадами (миграция 370).
 * Какая бригада и какие пределы КТУ — решает контроллер по тому же уровню.
 */
export const requireBrigadeSalaryAccess = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    if ((await getRequestBrigadeSalaryLevel(req)).kind === 'none') {
      res.status(403).json({ success: false, error: 'Нет доступа к выработке бригад' });
      return;
    }
    next();
  } catch (err) {
    console.error('requireBrigadeSalaryAccess error:', err);
    res.status(500).json({ success: false, error: 'Authorization check failed' });
  }
};
