import { type FC } from 'react';
import { UserRoundCheck, UserRoundMinus } from 'lucide-react';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import type { Employee } from '../../types';
import type { StaffInactiveAction } from '../../utils/staffInactive';

interface IStaffInactiveConfirmModalProps {
  emp: Employee;
  action: StaffInactiveAction;
  inFlight: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/** Подтверждение «Перевести в неактивные» / «Вернуть в активные» (миграция 381) — в стиле окна «Уволить». */
export const StaffInactiveConfirmModal: FC<IStaffInactiveConfirmModalProps> = ({ emp, action, inFlight, onCancel, onConfirm }) => {
  const overlayHandlers = useOverlayDismiss(onCancel);
  const deactivate = action === 'deactivate';
  const title = deactivate ? 'Перевести в неактивные' : 'Вернуть в активные';
  // Ручная метка у сотрудника из «Декрета»/«Архива»: снимается, но по отделу он остаётся неактивным.
  const stillInactiveBy = !deactivate ? emp.inactive_department_name ?? null : null;

  return (
    <div className="sc-overlay" {...overlayHandlers}>
      <div className="sc-modal" role="dialog" aria-label={title} onClick={e => e.stopPropagation()}>
        <div className="sc-modal-header">
          <h3>
            {deactivate
              ? <UserRoundMinus size={16} className="sc-modal-title-icon" aria-hidden="true" />
              : <UserRoundCheck size={16} className="sc-modal-title-icon" aria-hidden="true" />}
            {title}
          </h3>
          <button type="button" className="sc-modal-close" onClick={onCancel} disabled={inFlight} aria-label="Закрыть">&times;</button>
        </div>
        <div className="sc-modal-body">
          <p className="sc-inactive-confirm-text">
            {deactivate
              ? <>{emp.full_name} пропадёт из «Активных», вход на портал закроется.</>
              : stillInactiveBy
                ? <>Ручная метка будет снята, но {emp.full_name} останется неактивным — отдел «{stillInactiveBy}», вход закрыт.</>
                : <>{emp.full_name} вернётся в «Активные». Вход на портал откроется.</>}
          </p>
        </div>
        <div className="sc-modal-footer">
          <button type="button" className="sc-btn cancel" onClick={onCancel} disabled={inFlight}>Отмена</button>
          <button type="button" className="sc-btn apply" onClick={onConfirm} disabled={inFlight}>
            {inFlight ? 'Сохраняем…' : deactivate ? 'Перевести' : 'Вернуть'}
          </button>
        </div>
      </div>
    </div>
  );
};
