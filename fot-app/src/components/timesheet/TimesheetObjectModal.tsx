import { type FC } from 'react';
import { X, Check } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import { useToast } from '../../contexts/ToastContext';
import { ApiError } from '../../api/client';
import { timesheetObjectService } from '../../services/timesheetObjectService';
import type { TimesheetEmployee } from '../../types';
import styles from './TimesheetObjectModal.module.css';

interface ITimesheetObjectModalProps {
  employee: TimesheetEmployee;
  onClose: () => void;
}

/**
 * Выбор объекта табелирования в табеле — для того, кто ведёт табель сотрудника
 * (миграция 288). Нажатие на пункт сразу сохраняет выбор.
 */
export const TimesheetObjectModal: FC<ITimesheetObjectModalProps> = ({ employee, onClose }) => {
  const overlayHandlers = useOverlayDismiss(onClose);
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const stateQuery = useQuery({
    queryKey: ['timesheet-object', employee.id],
    queryFn: () => timesheetObjectService.getForEmployee(employee.id),
    staleTime: 0,
  });

  const mutation = useMutation({
    mutationFn: (value: string) => timesheetObjectService.updateForEmployee(employee.id, value),
    onSuccess: () => {
      showToast('success', 'Объект табелирования сохранён');
      void queryClient.invalidateQueries({ queryKey: ['timesheet'] });
      void queryClient.invalidateQueries({ queryKey: ['timesheet-page'] });
      void queryClient.invalidateQueries({ queryKey: ['timesheet-object', employee.id] });
      void queryClient.invalidateQueries({ queryKey: ['employee', employee.id] });
      onClose();
    },
    onError: (error: unknown) => {
      showToast('error', error instanceof ApiError ? error.message : 'Не удалось сохранить объект табелирования');
    },
  });

  const state = stateQuery.data;
  const options = state?.can_change ? state.options : [];

  return (
    <div className="ts-exclude-modal-overlay" {...overlayHandlers}>
      <div className={`ts-exclude-modal ${styles.modal}`} onClick={event => event.stopPropagation()}>
        <div className="ts-exclude-modal-header">
          <h3>Объект табелирования</h3>
          <button type="button" className="ts-exclude-modal-close" onClick={onClose} aria-label="Закрыть">
            <X size={18} />
          </button>
        </div>
        <div className="ts-exclude-modal-body">
          <div className={styles.employee}>{employee.full_name}</div>
          {stateQuery.isLoading && <div className={styles.muted}>Загрузка…</div>}
          {stateQuery.isError && <div className={styles.muted}>Не удалось загрузить объекты</div>}
          {state && options.length === 0 && (
            <div className={styles.current}>{state.label ?? '—'}</div>
          )}
          {options.length > 0 && (
            <ul className={styles.list}>
              {options.map(option => {
                const selected = option.value === state?.value;
                return (
                  <li key={option.value}>
                    <button
                      type="button"
                      className={`${styles.option} ${selected ? styles.optionSelected : ''}`}
                      onClick={() => { if (!selected) mutation.mutate(option.value); }}
                      disabled={mutation.isPending}
                      aria-pressed={selected}
                    >
                      <span className={styles.optionLabel}>{option.label}</span>
                      {selected && <Check size={16} aria-hidden="true" />}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
};
