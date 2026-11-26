import { type FC, type MouseEvent } from 'react';
import { UserRoundCheck, UserRoundMinus } from 'lucide-react';
import type { Employee } from '../../types';
import { staffInactiveActionFor, type StaffInactiveAction } from '../../utils/staffInactive';

interface IStaffInactiveActionButtonProps {
  emp: Employee;
  /** Нет обработчика — у пользователя нет права (флаг учётки can_manage_staff_inactive). */
  onAction?: (emp: Employee, action: StaffInactiveAction) => void;
  /** Мобильная карточка: клик не должен открывать карточку сотрудника. */
  stopPropagation?: boolean;
}

/** Иконка «Перевести в неактивные» / «Вернуть в активные» в столбце действий (миграция 381). */
export const StaffInactiveActionButton: FC<IStaffInactiveActionButtonProps> = ({ emp, onAction, stopPropagation = false }) => {
  if (!onAction) return null;
  const action = staffInactiveActionFor(emp);
  if (!action) return null;
  const title = action === 'deactivate' ? 'Перевести в неактивные' : 'Вернуть в активные';
  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (stopPropagation) event.stopPropagation();
    onAction(emp, action);
  };
  return (
    <button type="button" className="sc-btn-icon" title={title} aria-label={`${title}: ${emp.full_name}`} onClick={handleClick}>
      {action === 'deactivate' ? <UserRoundMinus size={14} /> : <UserRoundCheck size={14} />}
    </button>
  );
};
