import { useEffect, useMemo, useState, type FC } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { adminService, type TimesheetExportMode, type ITimesheetModeEmployee } from '../../services/adminService';
import { employeeService } from '../../services/employeeService';
import { useToast } from '../../contexts/ToastContext';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import type { Employee } from '../../types';

interface IProps {
  employee: Employee;
  row: ITimesheetModeEmployee | undefined;
  onClose: () => void;
  onSaved?: () => void;
}

const MODE_OPTIONS: Array<{ value: TimesheetExportMode; label: string; hint: string }> = [
  {
    value: 'current_activity',
    label: 'Текущая деятельность',
    hint: 'Одна строка, в колонке «Адрес объекта» — «Текущая деятельность».',
  },
  {
    value: 'object',
    label: 'Объект',
    hint: 'Одна строка с адресом закреплённого объекта, независимо от фактических проходов.',
  },
  {
    value: 'skud',
    label: 'По СКУД',
    hint: 'Разбивка по фактическим проходам: сколько объектов посетил — столько строк.',
  },
];

const SOURCE_HINTS: Record<string, string> = {
  employee_explicit: 'задан лично',
  department_explicit: 'унаследован от отдела',
  legacy_employee: 'выведен из персонального назначения объекта',
  legacy_department: 'выведен из назначения объекта отделу',
  legacy_default: 'по умолчанию',
};

/**
 * Режим табелирования сотрудника для выгрузки «Единый файл для 1С» (миграция 249).
 *
 * Отдельная сущность от назначения «объектов входа» (StaffObjectAssignmentModal): та
 * управляет скоупом табельщиц и правится только админом, а режим правит ещё и HR.
 */
export const StaffTimesheetModeModal: FC<IProps> = ({ employee, row, onClose, onSaved }) => {
  const toast = useToast();
  const queryClient = useQueryClient();
  const dismiss = useOverlayDismiss(onClose);

  const [saving, setSaving] = useState(false);

  // Строка режима могла не приехать в таблицу (запрос ещё шёл или упал). Тогда модалка
  // дозагружает её сама: инициализировать состояние как «наследовать», не зная реального
  // режима, нельзя — сохранение молча снесло бы существующую настройку.
  const selfQuery = useQuery({
    queryKey: ['admin-timesheet-modes', 'self', employee.id],
    queryFn: () => adminService.getTimesheetModes({ employeeIds: [employee.id] }),
    enabled: !row,
    staleTime: 30_000,
  });
  const loadedRow = row ?? selfQuery.data?.employees.find(e => e.employee_id === employee.id);
  const rowReady = Boolean(row) || selfQuery.isSuccess;

  // null = «наследовать»: явный режим снимается, работает режим отдела или legacy-фолбэк.
  const [mode, setMode] = useState<TimesheetExportMode | null>(row?.explicit_mode ?? null);
  const [objectId, setObjectId] = useState<string | null>(row?.explicit_object_id ?? null);
  // Подхватываем дозагруженное состояние ровно один раз.
  const [hydrated, setHydrated] = useState(Boolean(row));
  useEffect(() => {
    if (hydrated || !loadedRow) return;
    setMode(loadedRow.explicit_mode ?? null);
    setObjectId(loadedRow.explicit_object_id ?? null);
    setHydrated(true);
  }, [hydrated, loadedRow]);

  const objectsQuery = useQuery({
    queryKey: ['work-object-options'],
    queryFn: () => employeeService.listWorkObjectOptions(),
    staleTime: 5 * 60_000,
  });

  const objects = useMemo(() => objectsQuery.data ?? [], [objectsQuery.data]);

  const dirty = mode !== (loadedRow?.explicit_mode ?? null) || objectId !== (loadedRow?.explicit_object_id ?? null);
  const objectRequired = mode === 'object';
  const canSave = rowReady && dirty && !saving && (!objectRequired || Boolean(objectId));

  const handleSave = async (): Promise<void> => {
    setSaving(true);
    try {
      await adminService.updateEmployeeTimesheetMode(employee.id, mode, objectRequired ? objectId : null);
      // Режим влияет на выгрузку 1С — сбрасываем и режимы, и кэш табеля.
      await queryClient.invalidateQueries({ queryKey: ['admin-timesheet-modes'] });
      await queryClient.invalidateQueries({ queryKey: ['timesheet'] });
      toast.success('Режим табелирования сохранён');
      onSaved?.();
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не удалось сохранить режим');
    } finally {
      setSaving(false);
    }
  };

  const effectiveHint = loadedRow
    ? `Сейчас: ${MODE_OPTIONS.find(o => o.value === loadedRow.effective_mode)?.label ?? loadedRow.effective_mode}`
      + ` (${SOURCE_HINTS[loadedRow.source] ?? loadedRow.source})`
    : '';

  return (
    <div className="sc-overlay" {...dismiss}>
      <div className="sc-modal" onClick={e => e.stopPropagation()}>
        <div className="sc-modal-header">
          <h3>Режим табелирования — {employee.full_name}</h3>
          <button className="sc-modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="sc-modal-body">
          <p style={{ margin: '0 0 10px', fontSize: 13, color: 'var(--text-secondary, #64748b)' }}>
            Определяет колонку «Адрес объекта» в выгрузке «Единый файл для 1С». На сам табель,
            СКУД и права не влияет. {rowReady ? effectiveHint : 'Загрузка текущей настройки…'}
          </p>

          <div className="sc-obj-list">
            <label className={`sc-obj-item ${mode === null ? 'sc-obj-item--on' : ''}`}>
              <input type="radio" checked={mode === null} onChange={() => { setMode(null); setObjectId(null); }} />
              <span>
                Как у отдела
                <span className="sc-obj-empty" style={{ display: 'block', fontSize: 12 }}>
                  Личная настройка снимается — действует режим отдела.
                </span>
              </span>
            </label>
            {MODE_OPTIONS.map(option => (
              <label key={option.value} className={`sc-obj-item ${mode === option.value ? 'sc-obj-item--on' : ''}`}>
                <input
                  type="radio"
                  checked={mode === option.value}
                  onChange={() => { setMode(option.value); if (option.value !== 'object') setObjectId(null); }}
                />
                <span>
                  {option.label}
                  <span className="sc-obj-empty" style={{ display: 'block', fontSize: 12 }}>{option.hint}</span>
                </span>
              </label>
            ))}
          </div>

          {objectRequired && (
            <div className="sc-field" style={{ marginTop: 12 }}>
              <label htmlFor="ts-mode-object">Закреплённый объект</label>
              <select
                id="ts-mode-object"
                value={objectId ?? ''}
                onChange={e => setObjectId(e.target.value || null)}
              >
                <option value="">— выберите объект —</option>
                {objects.map(o => (
                  <option key={o.id} value={o.id}>{o.name}</option>
                ))}
              </select>
              {!objectId && (
                <div className="sc-obj-empty" style={{ fontSize: 12 }}>
                  Для режима «Объект» объект обязателен.
                </div>
              )}
              {loadedRow?.effective_object_is_active === false && objectId === loadedRow.explicit_object_id && (
                <div className="sc-obj-empty" style={{ fontSize: 12 }}>
                  Текущий объект неактивен — выберите другой.
                </div>
              )}
            </div>
          )}
        </div>
        <div className="sc-modal-footer">
          <button className="sc-btn cancel" onClick={onClose} disabled={saving}>Отмена</button>
          <button className="sc-btn apply" onClick={() => void handleSave()} disabled={!canSave}>
            <Check size={15} style={{ verticalAlign: 'text-bottom', marginRight: 4 }} />
            {saving ? 'Сохранение…' : 'Сохранить'}
          </button>
        </div>
      </div>
    </div>
  );
};
