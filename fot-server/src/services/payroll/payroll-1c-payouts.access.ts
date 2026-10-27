/**
 * Право загружать ведомости выплаты из 1С (миграция 328). Одна функция и для кнопки «Загрузить из 1С», и для API:
 * если кнопки нет, API тоже отказывает. Нужны правка «Расчётов» (/salary/payments) и весь штат «Зарплаты»:
 * ведомость — на всю организацию, частичный охват (админ компании, руководитель отдела) загружать не может.
 */
import type { AuthenticatedRequest } from '../../types/index.js';
import { resolveEffectivePageAccess } from '../access-control.service.js';
import { resolvePayrollReadableDepartmentIds } from './payroll-scope.service.js';

export async function canImportPayouts1c(req: AuthenticatedRequest): Promise<boolean> {
  if (!(await resolveEffectivePageAccess(req, '/salary/payments', 'edit'))) return false;
  return (await resolvePayrollReadableDepartmentIds(req)) === 'all';
}
