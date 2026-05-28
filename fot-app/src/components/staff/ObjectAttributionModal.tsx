import { useMemo, useState, type FC } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { employeeService } from '../../services/employeeService';
import { useToast } from '../../contexts/ToastContext';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import { getLocalISODate } from '../../pages/staffControlPage.helpers';
import { ApiError } from '../../api/client';
import type { Employee } from '../../types';

interface IObjectAttributionModalProps {
  employee: Employee;
  onClose: () => void;
  onSaved?: () => void;
}

const fmtPeriod = (from: string, to: string | null): string =>
  to ? `${from} — ${to}` : `${from} — по наст. время`;

/**
 * Датированная привязка удалёнщика к объекту (employee_object_attribution).
 * Открывается из «Управления кадрами» только для сотрудников с режимом remote.
 */
export const ObjectAttributionModal: FC<IObjectAttributionModalProps> = ({ employee, onClose, onSaved }) => {
  const toast = useToast();
  const queryClient = useQueryClient();
  const dismiss = useOverlayDismiss(onClose);

  const [objectId, setObjectId] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(getLocalISODate());
  const [reason, setReason] = useState('');

  const objectsQuery = useQuery({
    queryKey: ['attribution-objects'],
    queryFn: () => employeeService.listAttributionObjects(),
    staleTime: 5 * 60 * 1000,
  });

  const attributionQuery = useQuery({
    queryKey: ['object-attribution', employee.id],
    queryFn: () => employeeService.getObjectAttribution(employee.id),
  });

  const current = attributionQuery.data?.current ?? null;
  const history = attributionQuery.data?.history ?? [];

  const saveMutation = useMutation({
    mutationFn: () => employeeService.setObjectAttribution(employee.id, {
      skud_object_id: objectId,
      effective_from: effectiveFrom,
      reason: reason.trim() || null,
    }),
    onSuccess: () => {
      toast.success('Привязка к объекту сохранена');
      queryClient.invalidateQueries({ queryKey: ['object-attribution', employee.id] });
      // Табель «По объектам» зависит от привязки — сбрасываем его кэш на клиенте.
      queryClient.invalidateQueries({ queryKey: ['timesheet'] });
      setReason('');
      onSaved?.();
    },
    onError: (err) => {
      const msg = err instanceof ApiError ? err.message : 'Не удалось сохранить привязку';
      toast.error(msg);
    },
  });

  const isUnchanged = useMemo(
    () => !!current && current.object_id === objectId && current.effective_from <= effectiveFrom,
    [current, objectId, effectiveFrom],
  );
  const canSave = !!objectId && !!effectiveFrom && !isUnchanged && !saveMutation.isPending;

  return (
    <div className="sc-overlay" {...dismiss}>
      <div className="sc-modal" onClick={e => e.stopPropagation()}>
        <div className="sc-modal-header">
          <h3>Привязка к объекту — {employee.full_name}</h3>
          <button className="sc-modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="sc-modal-body">
          <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--text-secondary, #64748b)' }}>
            Для удалёнщиков без СКУД часы относятся к этому объекту. В дни с реальными
            проходами всегда показывается фактический объект — привязка не маскирует его.
          </p>

          <div className="sc-field">
            <label>Текущая привязка</label>
            <div style={{ fontSize: 14 }}>
              {attributionQuery.isLoading
                ? 'Загрузка…'
                : current
                  ? `${current.object_name} (с ${current.effective_from})`
                  : '— не задана'}
            </div>
          </div>

          <div className="sc-field">
            <label>Объект</label>
            <select value={objectId} onChange={e => setObjectId(e.target.value)} autoFocus>
              <option value="">— выберите объект —</option>
              {(objectsQuery.data ?? []).map(obj => (
                <option key={obj.id} value={obj.id}>{obj.name}</option>
              ))}
            </select>
          </div>

          <div className="sc-field">
            <label>Действует с</label>
            <input type="date" value={effectiveFrom} onChange={e => setEffectiveFrom(e.target.value)} />
          </div>

          <div className="sc-field">
            <label>Причина</label>
            <input value={reason} onChange={e => setReason(e.target.value)} placeholder="Перевод на объект, уточнение…" />
          </div>

          {history.length > 0 && (
            <div className="sc-field">
              <label>История привязок</label>
              <div style={{ maxHeight: 180, overflowY: 'auto', fontSize: 13 }}>
                {history.map(row => (
                  <div
                    key={row.id}
                    style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '4px 0', borderBottom: '1px solid var(--border-color, #e2e8f0)' }}
                  >
                    <span>{row.object_name}</span>
                    <span style={{ color: 'var(--text-secondary, #64748b)', whiteSpace: 'nowrap' }}>
                      {fmtPeriod(row.effective_from, row.effective_to)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="sc-modal-footer">
          <button className="sc-btn cancel" onClick={onClose}>Отмена</button>
          <button className="sc-btn apply" onClick={() => saveMutation.mutate()} disabled={!canSave}>
            {saveMutation.isPending ? 'Сохранение…' : 'Сохранить'}
          </button>
        </div>
      </div>
    </div>
  );
};
