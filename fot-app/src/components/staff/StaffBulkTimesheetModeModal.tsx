import { useMemo, useState, type FC } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { adminService, type TimesheetExportMode } from '../../services/adminService';
import { employeeService } from '../../services/employeeService';
import { useToast } from '../../contexts/ToastContext';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';

interface IProps {
  departmentId: string;
  departmentName: string;
  /** Текущий явный режим отдела (null = не задан, работает legacy). */
  currentMode: TimesheetExportMode | null;
  currentObjectId: string | null;
  onClose: () => void;
}

const MODE_OPTIONS: Array<{ value: TimesheetExportMode; label: string }> = [
  { value: 'current_activity', label: 'Текущая деятельность' },
  { value: 'object', label: 'Объект (один закреплённый адрес)' },
  { value: 'skud', label: 'По СКУД (разбивка по проходам)' },
];

/**
 * Режим табелирования для отдела целиком (миграция 249).
 *
 * «Включая подотделы» записывает режим во ВСЕ существующие дочерние отделы одной
 * транзакцией. Наследования по дереву нет: отделы, созданные позже, режим не подхватят —
 * их нужно настроить отдельно.
 */
export const StaffBulkTimesheetModeModal: FC<IProps> = ({
  departmentId, departmentName, currentMode, currentObjectId, onClose,
}) => {
  const toast = useToast();
  const queryClient = useQueryClient();
  const dismiss = useOverlayDismiss(onClose);

  const [saving, setSaving] = useState(false);
  const [mode, setMode] = useState<TimesheetExportMode | null>(currentMode);
  const [objectId, setObjectId] = useState<string | null>(currentObjectId);
  const [subtree, setSubtree] = useState(false);

  const objectsQuery = useQuery({
    queryKey: ['work-object-options'],
    queryFn: () => employeeService.listWorkObjectOptions(),
    staleTime: 5 * 60_000,
  });
  const objects = useMemo(() => objectsQuery.data ?? [], [objectsQuery.data]);

  const objectRequired = mode === 'object';
  const canSave = !saving && (!objectRequired || Boolean(objectId));

  const handleSave = async (): Promise<void> => {
    setSaving(true);
    try {
      await adminService.updateDepartmentTimesheetMode(
        departmentId, mode, objectRequired ? objectId : null, subtree,
      );
      await queryClient.invalidateQueries({ queryKey: ['admin-timesheet-modes'] });
      await queryClient.invalidateQueries({ queryKey: ['timesheet'] });
      toast.success(subtree ? 'Режим применён к отделу и подотделам' : 'Режим отдела сохранён');
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не удалось сохранить режим');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="sc-overlay" {...dismiss}>
      <div className="sc-modal" onClick={e => e.stopPropagation()}>
        <div className="sc-modal-header">
          <h3>Режим табелирования — {departmentName}</h3>
          <button className="sc-modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="sc-modal-body">
          <p style={{ margin: '0 0 10px', fontSize: 13, color: 'var(--text-secondary, #64748b)' }}>
            Режим по умолчанию для сотрудников отдела в выгрузке «Единый файл для 1С».
            Персональный режим сотрудника его перекрывает.
          </p>

          <div className="sc-obj-list">
            <label className={`sc-obj-item ${mode === null ? 'sc-obj-item--on' : ''}`}>
              <input type="radio" checked={mode === null} onChange={() => { setMode(null); setObjectId(null); }} />
              <span>Не задавать (как раньше — по назначениям объектов)</span>
            </label>
            {MODE_OPTIONS.map(option => (
              <label key={option.value} className={`sc-obj-item ${mode === option.value ? 'sc-obj-item--on' : ''}`}>
                <input
                  type="radio"
                  checked={mode === option.value}
                  onChange={() => { setMode(option.value); if (option.value !== 'object') setObjectId(null); }}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>

          {objectRequired && (
            <div className="sc-field" style={{ marginTop: 12 }}>
              <label htmlFor="bulk-ts-object">Закреплённый объект</label>
              <select id="bulk-ts-object" value={objectId ?? ''} onChange={e => setObjectId(e.target.value || null)}>
                <option value="">— выберите объект —</option>
                {objects.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
            </div>
          )}

          <label className="sc-obj-item" style={{ marginTop: 12 }}>
            <input type="checkbox" checked={subtree} onChange={e => setSubtree(e.target.checked)} />
            <span>
              Включая подотделы
              <span className="sc-obj-empty" style={{ display: 'block', fontSize: 12 }}>
                Режим запишется во все существующие дочерние отделы. Новые подотделы его не унаследуют.
              </span>
            </span>
          </label>
        </div>
        <div className="sc-modal-footer">
          <button className="sc-btn cancel" onClick={onClose} disabled={saving}>Отмена</button>
          <button className="sc-btn apply" onClick={() => void handleSave()} disabled={!canSave}>
            <Check size={15} style={{ verticalAlign: 'text-bottom', marginRight: 4 }} />
            {saving ? 'Сохранение…' : 'Применить'}
          </button>
        </div>
      </div>
    </div>
  );
};
