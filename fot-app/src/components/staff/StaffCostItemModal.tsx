import { useState, type FC } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { ApiError } from '../../api/client';
import {
  adminService,
  TIMESHEET_MODE_CONFLICT_CODE,
  type ITimesheetModeEmployee,
  type TimesheetExportMode,
} from '../../services/adminService';
import { useToast } from '../../contexts/ToastContext';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import { STAFF_MAIN_OBJECTS_QUERY_KEY } from '../../hooks/useStaffMainObjects';
import { refreshStaffChunksFor } from '../../utils/staffChunkInvalidation';
import type { Employee } from '../../types';
import { TimesheetModeOptionsColumn } from './TimesheetModeOptionsColumn';
import { formatTimesheetModeText } from './timesheetModeLabels';

interface IProps {
  employee: Employee;
  onClose: () => void;
}

interface IExplicitMode {
  mode: TimesheetExportMode | null;
  objectId: string | null;
}

/** Явный (личный) режим строки; объект значим только у режима object. */
const explicitOf = (row: ITimesheetModeEmployee): IExplicitMode => ({
  mode: row.explicit_mode,
  objectId: row.explicit_mode === 'object' ? row.explicit_object_id : null,
});

const sameMode = (a: IExplicitMode, b: IExplicitMode): boolean =>
  a.mode === b.mode && (a.mode !== 'object' || a.objectId === b.objectId);

const describeMode = (mode: IExplicitMode, objectName: string | null): string =>
  (mode.mode ? formatTimesheetModeText(mode.mode, objectName) : 'режим отдела');

/**
 * «Статья затрат» сотрудника = его личный режим табелирования. Запись идёт одиночным PUT
 * с expected: если режим успели поменять, сервер отвечает 409, выбор пользователя остаётся,
 * expected становится серверным значением — повторное «Сохранить» проходит осознанно.
 */
export const StaffCostItemModal: FC<IProps> = ({ employee, onClose }) => {
  const queryClient = useQueryClient();
  const toast = useToast();
  const dismiss = useOverlayDismiss(onClose);

  const modeQuery = useQuery({
    queryKey: ['admin-timesheet-modes', 'cost-item', employee.id],
    queryFn: () => adminService.getTimesheetModesForEmployees([employee.id], { includeCanEdit: true }),
    // Фоновый перезапрос молча сдвинул бы expected и снял защиту от чужой правки.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const row = modeQuery.data?.find(item => item.employee_id === employee.id) ?? null;

  // expected — то, что пользователь видел на сервере; после 409 — присланное сервером.
  const [conflictExpected, setConflictExpected] = useState<IExplicitMode | null>(null);
  const expected: IExplicitMode | null = conflictExpected ?? (row ? explicitOf(row) : null);

  // Выбор пользователя; пока не трогал — показываем текущий личный режим.
  const [picked, setPicked] = useState<IExplicitMode | null>(null);
  const selection: IExplicitMode | null = picked ?? expected;

  const [busy, setBusy] = useState(false);
  const [conflictMessage, setConflictMessage] = useState<string | null>(null);

  const canEdit = row?.can_edit === true;
  const readOnly = modeQuery.isPending || modeQuery.isError || !canEdit || busy;
  const selectionComplete = Boolean(selection?.mode) && (selection?.mode !== 'object' || Boolean(selection?.objectId));
  const canSave = !readOnly && expected !== null && selection !== null && selectionComplete && !sameMode(selection, expected);
  const canReset = !readOnly && expected !== null && expected.mode !== null;

  const save = async (next: IExplicitMode): Promise<void> => {
    if (!expected) return;
    setBusy(true);
    setConflictMessage(null);
    try {
      const result = await adminService.updateEmployeeTimesheetMode(employee.id, {
        mode: next.mode,
        object_id: next.mode === 'object' ? next.objectId : null,
        expected: { mode: expected.mode, object_id: expected.objectId },
      });
      await Promise.all([
        // Только порция этого сотрудника: при тысячах загруженных строк — один запрос, а не все порции.
        refreshStaffChunksFor(queryClient, [STAFF_MAIN_OBJECTS_QUERY_KEY], [employee.id]),
        queryClient.invalidateQueries({ queryKey: ['admin-timesheet-modes'] }),
        queryClient.invalidateQueries({ queryKey: ['admin-timesheet-mode-departments'] }),
        queryClient.invalidateQueries({ queryKey: ['timesheet'] }),
      ]);
      if (result.changed) toast.success('Статья затрат сохранена');
      else toast.info('Без изменений: такой режим уже установлен');
      onClose();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && error.code === TIMESHEET_MODE_CONFLICT_CODE) {
        const current = (error.details?.data as { current?: { mode: TimesheetExportMode | null; object_id: string | null } } | undefined)?.current;
        const serverMode: IExplicitMode = { mode: current?.mode ?? null, objectId: current?.object_id ?? null };
        // Выбор пользователя НЕ сбрасываем: он решает, сохранять ли поверх нового значения.
        setPicked(prev => prev ?? next);
        setConflictExpected(serverMode);
        void modeQuery.refetch();
        setConflictMessage(`Режим уже изменил другой пользователь: сейчас ${describeMode(serverMode, null)}. Проверьте выбор и сохраните ещё раз.`);
      } else {
        toast.error(error instanceof Error ? error.message : 'Не удалось сохранить статью затрат');
      }
    } finally {
      setBusy(false);
    }
  };

  const handleReset = (): void => {
    if (!window.confirm(`Вернуть сотрудника «${employee.full_name}» к режиму отдела?`)) return;
    void save({ mode: null, objectId: null });
  };

  const inactiveCurrent = row && row.effective_mode === 'object' && row.effective_object_is_active === false
    ? { name: row.effective_object_name, address: row.effective_object_address }
    : null;

  let hint: string;
  if (modeQuery.isError) hint = 'Не удалось загрузить режим — изменение недоступно.';
  else if (modeQuery.isPending) hint = 'Загрузка режима…';
  else if (!row || !canEdit) hint = 'Нет права менять режим табелирования этого сотрудника.';
  else if (row.explicit_mode) hint = 'Задан личный режим сотрудника. Он влияет на табель и выгрузку в 1С.';
  else hint = `Сейчас действует режим отдела: ${formatTimesheetModeText(row.effective_mode, row.effective_object_name)}. Сохранение задаст личный режим — он влияет на табель и выгрузку в 1С.`;

  return (
    <div className="sc-overlay" {...dismiss}>
      <div
        className="sc-modal sc-modal--full sc-modal--cost-item"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cost-item-modal-title"
        onClick={e => e.stopPropagation()}
      >
        <div className="sc-modal-header">
          <h3 id="cost-item-modal-title">Статья затрат — {employee.full_name}</h3>
          <button className="sc-modal-close" onClick={onClose} aria-label="Закрыть">&times;</button>
        </div>

        <div className="sc-modal-body sc-mode-body sc-mode-body--single">
          {conflictMessage && <div className="sc-cost-item-conflict" role="alert">{conflictMessage}</div>}
          <TimesheetModeOptionsColumn
            mode={selection?.mode ?? undefined}
            objectId={selection?.objectId ?? null}
            onSelect={(mode, objectId) => setPicked({ mode, objectId })}
            current={row ? { mode: row.effective_mode, objectId: row.effective_object_id } : null}
            hint={hint}
            readOnly={readOnly}
            inactiveCurrent={inactiveCurrent}
          />
        </div>

        <div className="sc-modal-footer">
          <button className="sc-btn cancel" onClick={onClose} disabled={busy}>Отмена</button>
          {canReset && (
            <button className="sc-btn secondary" onClick={handleReset} title="Убрать личный режим и вернуться к режиму отдела">
              Как у отдела
            </button>
          )}
          <button
            className="sc-btn apply"
            onClick={() => { if (selection) void save(selection); }}
            disabled={!canSave}
          >
            <Check size={15} className="sc-mode-apply-icon" />
            {busy ? 'Сохранение…' : 'Сохранить'}
          </button>
        </div>
      </div>
    </div>
  );
};
