import { useCallback, useState } from 'react';
import { ApiError } from '../api/client';
import { useToast } from '../contexts/ToastContext';
import { employeeService } from '../services/employeeService';
import type { Employee } from '../types';
import type { StaffInactiveAction } from '../utils/staffInactive';

interface IStaffInactiveTarget {
  emp: Employee;
  action: StaffInactiveAction;
}

/**
 * «Перевести в неактивные» / «Вернуть в активные» (миграция 381): выбор строки → окно подтверждения → запрос.
 * После ответа — и после отказа 409 (состояние сменилось) — список и счётчики перечитываются.
 */
export const useStaffInactiveAction = (
  refreshAfterChange: (employeeIds: readonly number[], options: { listChanged: boolean }) => Promise<void>,
) => {
  const toast = useToast();
  const [target, setTarget] = useState<IStaffInactiveTarget | null>(null);
  const [inFlight, setInFlight] = useState(false);

  const open = useCallback((emp: Employee, action: StaffInactiveAction) => setTarget({ emp, action }), []);

  const close = useCallback(() => {
    if (!inFlight) setTarget(null);
  }, [inFlight]);

  const confirm = useCallback(async () => {
    if (!target) return;
    const { emp, action } = target;
    setInFlight(true);
    try {
      if (action === 'deactivate') {
        await employeeService.deactivate(emp.id);
        toast.success(`${emp.full_name}: переведён в неактивные, вход на портал закрыт`);
      } else {
        const result = await employeeService.reactivate(emp.id);
        if (result.inactive_department_name) {
          toast.warning(`${emp.full_name}: метка снята, но вход закрыт — отдел «${result.inactive_department_name}»`);
        } else {
          toast.success(`${emp.full_name}: возвращён в активные`);
        }
      }
      setTarget(null);
      void refreshAfterChange([emp.id], { listChanged: true });
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : 'Не удалось изменить статус сотрудника');
      // 409 — состояние уже другое (уволен, переведён другим запросом): показываем актуальный список.
      if (error instanceof ApiError && error.status === 409) {
        setTarget(null);
        void refreshAfterChange([emp.id], { listChanged: true });
      }
    } finally {
      setInFlight(false);
    }
  }, [target, toast, refreshAfterChange]);

  return { target, inFlight, open, close, confirm };
};
