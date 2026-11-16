import { useCallback, useMemo } from 'react';
import { useLocation, useNavigate, type NavigateOptions } from 'react-router-dom';

import { useAuth } from '../contexts/AuthContext';
import { isPayrollBackActive, PAYROLL_CALC_PATH, readPayrollTimesheetBack } from '../utils/payrollViews';

interface IUsePayrollTimesheetBackArgs {
  isEmployeeMode: boolean;
  /** Сотрудник «По сотруднику» из адреса табеля. */
  employeeId: number | null;
}

interface IPayrollTimesheetBackApi {
  /** Показать «← Зарплата». */
  active: boolean;
  /**
   * Второй аргумент setSearchParams табеля для месяца, половины и вида: пока возврат действует, запись истории
   * заменяется вместе с ним — «Назад» браузера ведёт сразу на «Расчёты». undefined — как обычно (новая запись).
   */
  keepNav: NavigateOptions | undefined;
  goBack: () => void;
}

/**
 * Возврат из табеля «По сотруднику» в окно «Расчётов» (табель открыт кликом по ФИО в окне). Запись возврата — в
 * записи истории табеля; кнопка — только тому же входу, с правами «Зарплаты» (их даёт только список раздела) и в
 * табеле того же сотрудника. Смена режима или сотрудника пишет новую запись без неё — возврат снят.
 */
export const usePayrollTimesheetBack = ({ isEmployeeMode, employeeId }: IUsePayrollTimesheetBackArgs): IPayrollTimesheetBackApi => {
  const location = useLocation();
  const navigate = useNavigate();
  const { profile, canViewPage } = useAuth();
  const back = useMemo(() => readPayrollTimesheetBack(location.state), [location.state]);
  const active = isPayrollBackActive({
    back,
    profileId: profile?.id,
    canPayroll: canViewPage('/salary/terms') && canViewPage('/salary/payments'),
    isEmployeeMode,
    employeeId,
  });

  const keepNav = useMemo<NavigateOptions | undefined>(
    () => (active ? { replace: true, state: location.state } : undefined),
    [active, location.state],
  );

  // Месяц и половина заменяют запись — позади неё запись «Расчётов» с тем же возвратом. Позади ничего (idx 0:
  // вкладку открыли с этой записи) — «Расчёты» заменой, без лишней записи.
  const goBack = useCallback(() => {
    if (!active || !back) return;
    const idx: unknown = (window.history.state as { idx?: unknown } | null)?.idx;
    if (typeof idx === 'number' && idx > 0) {
      navigate(-1);
      return;
    }
    navigate(PAYROLL_CALC_PATH, { replace: true, state: { payrollReturn: back.payrollReturn } });
  }, [active, back, navigate]);

  return { active, keepNav, goBack };
};
