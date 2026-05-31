import { useEffect, useMemo, useState, type FC } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { adminService } from '../../services/adminService';
import { useToast } from '../../contexts/ToastContext';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import {
  groupObjects,
  groupSelectionState,
  objectGroupLabelsForIds,
  type IObjectGroup,
} from '../../utils/objectGroups';
import type { IObjectAssignments } from '../../services/adminService';
import type { Employee } from '../../types';

interface IProps {
  employee: Employee;
  onClose: () => void;
  onSaved?: () => void;
}

const arraysEqual = (a: string[], b: string[]): boolean => {
  if (a.length !== b.length) return false;
  const x = [...a].sort();
  const y = [...b].sort();
  return x.every((v, i) => v === y[i]);
};

const normalize = (s: string): string => s.toLowerCase().replace(/ё/g, 'е').trim();

const setIndeterminate = (el: HTMLInputElement | null, value: boolean): void => {
  if (el) el.indeterminate = value;
};

/**
 * Персональное назначение «объектов входа» сотруднику (employee_object_assignment).
 * Переопределяет объекты бригады. Объекты сгруппированы по адресу (объекты с одним
 * адресом — один пункт). Сверху назначенные, ниже доступные. Объект с адресом
 * «Текущая деятельность» → в единой 1С-выгрузке одна строка без разбивки.
 */
export const StaffObjectAssignmentModal: FC<IProps> = ({ employee, onClose, onSaved }) => {
  const toast = useToast();
  const queryClient = useQueryClient();
  const dismiss = useOverlayDismiss(onClose);

  const departmentId = employee.org_department_id ?? null;
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<string[] | null>(null);
  const [search, setSearch] = useState('');

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

  const objects = useMemo(() => objectsQuery.data ?? [], [objectsQuery.data]);
  const groups = useMemo(() => groupObjects(objects), [objects]);

  const empObjectIds = useMemo(
    () => assignmentsQuery.data?.employee_objects?.[String(employee.id)] ?? [],
    [assignmentsQuery.data, employee.id],
  );
  const deptObjectIds = useMemo(
    () => (departmentId ? assignmentsQuery.data?.department_objects?.[departmentId] ?? [] : []),
    [assignmentsQuery.data, departmentId],
  );

  // Сброс черновика при прилёте свежих данных.
  useEffect(() => { setDraft(null); }, [empObjectIds]);

  const current = draft ?? empObjectIds;
  const currentSet = useMemo(() => new Set(current), [current]);
  const hasChanges = !arraysEqual(current, empObjectIds);

  const toggleGroup = (group: IObjectGroup) => {
    const state = groupSelectionState(group, currentSet);
    setDraft(() => {
      const set = new Set(current);
      if (state === 'all') group.objectIds.forEach(id => set.delete(id));
      else group.objectIds.forEach(id => set.add(id));
      return [...set];
    });
  };

  const filteredGroups = useMemo(() => {
    const q = normalize(search);
    if (!q) return groups;
    return groups.filter(g => normalize(g.label).includes(q));
  }, [groups, search]);

  const assignedGroups = filteredGroups.filter(g => groupSelectionState(g, currentSet) !== 'none');
  const availableGroups = filteredGroups.filter(g => groupSelectionState(g, currentSet) === 'none');

  const inheritedLabels = useMemo(
    () => objectGroupLabelsForIds(objects, deptObjectIds),
    [objects, deptObjectIds],
  );

  const handleSave = async () => {
    setSaving(true);
    try {
      const saved = [...current];
      await adminService.updateEmployeeObjectAssignment(employee.id, saved);
      // Оптимистично обновляем кэш назначений — столбец «Объект» обновляется сразу
      // (глобально refetchOnMount:false, поэтому не полагаемся только на invalidate).
      queryClient.setQueryData<IObjectAssignments>(['admin-object-assignments'], old => (
        old ? { ...old, employee_objects: { ...old.employee_objects, [String(employee.id)]: saved } } : old
      ));
      queryClient.invalidateQueries({ queryKey: ['admin-object-assignments'] });
      // 1С-выгрузка «текущей деятельности» зависит от назначений — сбрасываем кэш табеля.
      queryClient.invalidateQueries({ queryKey: ['timesheet'] });
      toast.success('Персональные объекты обновлены');
      setDraft(null);
      onSaved?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Ошибка сохранения');
    } finally {
      setSaving(false);
    }
  };

  const loading = objectsQuery.isLoading || assignmentsQuery.isLoading;

  const renderGroup = (group: IObjectGroup) => {
    const state = groupSelectionState(group, currentSet);
    return (
      <label key={group.key} className={`sc-obj-item ${state !== 'none' ? 'sc-obj-item--on' : ''}`}>
        <input
          type="checkbox"
          checked={state === 'all'}
          ref={el => setIndeterminate(el, state === 'partial')}
          onChange={() => toggleGroup(group)}
        />
        <span>
          {group.label}
          {group.objectIds.length > 1 && <span className="sc-obj-count">{group.objectIds.length}</span>}
        </span>
      </label>
    );
  };

  return (
    <div className="sc-overlay" {...dismiss}>
      <div className="sc-modal" onClick={e => e.stopPropagation()}>
        <div className="sc-modal-header">
          <h3>Объект — {employee.full_name}</h3>
          <button className="sc-modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="sc-modal-body">
          <p style={{ margin: '0 0 10px', fontSize: 13, color: 'var(--text-secondary, #64748b)' }}>
            Персональное назначение объектов сотруднику — переопределяет объекты бригады. Объекты
            сгруппированы по адресу. «Текущая деятельность» в единой 1С-выгрузке идёт одной строкой
            без разбивки. Объекты на отделы/бригады назначаются массово через меню «•••».
          </p>

          {inheritedLabels.length > 0 && (
            <div className="sc-field" style={{ fontSize: 13 }}>
              <label>Наследуется от бригады</label>
              <div style={{ color: 'var(--text-secondary, #64748b)' }}>{inheritedLabels.join(', ')}</div>
            </div>
          )}

          {objects.length > 8 && (
            <input
              type="text"
              className="sc-obj-search"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Поиск по адресу…"
            />
          )}

          {loading ? (
            <div style={{ fontSize: 14 }}>Загрузка…</div>
          ) : groups.length === 0 ? (
            <div style={{ fontSize: 14 }}>Объекты не настроены</div>
          ) : (
            <div className="sc-obj-list">
              <div className="sc-obj-group-label">Назначенные{assignedGroups.length > 0 ? ` (${assignedGroups.length})` : ''}</div>
              {assignedGroups.length > 0
                ? assignedGroups.map(renderGroup)
                : <div className="sc-obj-empty">— нет персональных объектов —</div>}
              <div className="sc-obj-group-label">Доступные</div>
              {availableGroups.length > 0
                ? availableGroups.map(renderGroup)
                : <div className="sc-obj-empty">— все объекты назначены —</div>}
            </div>
          )}
        </div>
        <div className="sc-modal-footer">
          <button className="sc-btn cancel" onClick={onClose} disabled={saving}>Отмена</button>
          <button className="sc-btn apply" onClick={() => void handleSave()} disabled={!hasChanges || saving}>
            <Check size={15} style={{ verticalAlign: 'text-bottom', marginRight: 4 }} />
            {saving ? 'Сохранение…' : 'Сохранить'}
          </button>
        </div>
      </div>
    </div>
  );
};
