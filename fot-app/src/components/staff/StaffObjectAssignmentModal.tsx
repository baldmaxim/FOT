import { useEffect, useMemo, useState, type FC } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { adminService } from '../../services/adminService';
import { useToast } from '../../contexts/ToastContext';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import type { Employee } from '../../types';

interface IProps {
  employee: Employee;
  onClose: () => void;
  onSaved?: () => void;
}

type Level = 'dept' | 'emp';

const arraysEqual = (a: string[], b: string[]): boolean => {
  if (a.length !== b.length) return false;
  const x = [...a].sort();
  const y = [...b].sort();
  return x.every((v, i) => v === y[i]);
};

/**
 * Назначение «объектов входа» сотруднику на двух уровнях:
 *   - Бригада/отдел (department_object_assignment) — наследуют все члены отдела;
 *   - Сотрудник (employee_object_assignment) — персональное переопределение.
 * Объект с адресом «Текущая деятельность» → в единой 1С-выгрузке одна строка на
 * сотрудника без разбивки по объектам.
 */
export const StaffObjectAssignmentModal: FC<IProps> = ({ employee, onClose, onSaved }) => {
  const toast = useToast();
  const queryClient = useQueryClient();
  const dismiss = useOverlayDismiss(onClose);

  const departmentId = employee.org_department_id ?? null;
  const [level, setLevel] = useState<Level>(departmentId ? 'dept' : 'emp');
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<string[] | null>(null);

  const objectsQuery = useQuery({
    queryKey: ['admin-skud-objects'],
    queryFn: () => adminService.listSkudObjectsForAssignment(),
    staleTime: 5 * 60_000,
  });
  const assignmentsQuery = useQuery({
    queryKey: ['admin-object-assignments'],
    queryFn: () => adminService.getObjectAssignments(),
    staleTime: 30_000,
  });

  const objects = objectsQuery.data ?? [];
  const deptObjectIds = useMemo(
    () => (departmentId ? assignmentsQuery.data?.department_objects?.[departmentId] ?? [] : []),
    [assignmentsQuery.data, departmentId],
  );
  const empObjectIds = useMemo(
    () => assignmentsQuery.data?.employee_objects?.[String(employee.id)] ?? [],
    [assignmentsQuery.data, employee.id],
  );

  const baseValue = level === 'dept' ? deptObjectIds : empObjectIds;
  // Сброс черновика при смене уровня или прилёте свежих данных.
  useEffect(() => { setDraft(null); }, [level, deptObjectIds, empObjectIds]);

  const current = draft ?? baseValue;
  const hasChanges = !arraysEqual(current, baseValue);

  const toggle = (id: string) => {
    setDraft(() => {
      const set = new Set(current);
      if (set.has(id)) set.delete(id);
      else set.add(id);
      return [...set];
    });
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      if (level === 'dept') {
        if (!departmentId) return;
        await adminService.updateDepartmentObjectAssignment(departmentId, current);
        toast.success('Объекты бригады обновлены');
      } else {
        await adminService.updateEmployeeObjectAssignment(employee.id, current);
        toast.success('Персональные объекты обновлены');
      }
      await queryClient.invalidateQueries({ queryKey: ['admin-object-assignments'] });
      // 1С-выгрузка «текущей деятельности» зависит от назначений — сбрасываем кэш табеля.
      queryClient.invalidateQueries({ queryKey: ['timesheet'] });
      setDraft(null);
      onSaved?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Ошибка сохранения');
    } finally {
      setSaving(false);
    }
  };

  const loading = objectsQuery.isLoading || assignmentsQuery.isLoading;

  return (
    <div className="sc-overlay" {...dismiss}>
      <div className="sc-modal" onClick={e => e.stopPropagation()}>
        <div className="sc-modal-header">
          <h3>Объект — {employee.full_name}</h3>
          <button className="sc-modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="sc-modal-body">
          <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--text-secondary, #64748b)' }}>
            «Бригада» — объект наследуют все сотрудники отдела. «Сотрудник» — персональное
            переопределение. Объект с адресом «Текущая деятельность» в единой 1С-выгрузке идёт
            одной строкой без разбивки по объектам.
          </p>

          <div className="sc-obj-tabs">
            <button
              type="button"
              className={`sc-obj-tab ${level === 'dept' ? 'sc-obj-tab--on' : ''}`}
              onClick={() => setLevel('dept')}
              disabled={!departmentId}
              title={departmentId ? undefined : 'У сотрудника не задан отдел'}
            >
              Бригада{deptObjectIds.length > 0 ? ` (${deptObjectIds.length})` : ''}
            </button>
            <button
              type="button"
              className={`sc-obj-tab ${level === 'emp' ? 'sc-obj-tab--on' : ''}`}
              onClick={() => setLevel('emp')}
            >
              Сотрудник{empObjectIds.length > 0 ? ` (${empObjectIds.length})` : ''}
            </button>
          </div>

          <div className="sc-field">
            {loading ? (
              <div style={{ fontSize: 14 }}>Загрузка…</div>
            ) : objects.length === 0 ? (
              <div style={{ fontSize: 14 }}>Объекты не настроены</div>
            ) : (
              <div className="sc-obj-list">
                {objects.map(obj => {
                  const checked = current.includes(obj.id);
                  return (
                    <label key={obj.id} className={`sc-obj-item ${checked ? 'sc-obj-item--on' : ''}`}>
                      <input type="checkbox" checked={checked} onChange={() => toggle(obj.id)} />
                      <span>{obj.name}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        </div>
        <div className="sc-modal-footer">
          <button className="sc-btn cancel" onClick={onClose} disabled={saving}>Отмена</button>
          <button
            className="sc-btn apply"
            onClick={() => void handleSave()}
            disabled={!hasChanges || saving || (level === 'dept' && !departmentId)}
          >
            {saving ? 'Сохранение…' : 'Сохранить'}
          </button>
        </div>
      </div>
    </div>
  );
};
