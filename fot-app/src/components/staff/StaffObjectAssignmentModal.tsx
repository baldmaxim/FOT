import { useEffect, useMemo, useState, type FC } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { adminService } from '../../services/adminService';
import { useToast } from '../../contexts/ToastContext';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
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

/**
 * Персональное назначение «объектов входа» сотруднику (employee_object_assignment).
 * Переопределяет объекты его отдела/бригады. Сверху — уже назначенные объекты,
 * ниже — доступные. Объект с адресом «Текущая деятельность» → в единой 1С-выгрузке
 * одна строка на сотрудника без разбивки по объектам.
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

  const objects = objectsQuery.data ?? [];
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
  const hasChanges = !arraysEqual(current, empObjectIds);

  const toggle = (id: string) => {
    setDraft(() => {
      const set = new Set(current);
      if (set.has(id)) set.delete(id);
      else set.add(id);
      return [...set];
    });
  };

  const filtered = useMemo(() => {
    const q = normalize(search);
    if (!q) return objects;
    return objects.filter(o => normalize(o.name).includes(q));
  }, [objects, search]);

  const assigned = filtered.filter(o => current.includes(o.id));
  const available = filtered.filter(o => !current.includes(o.id));

  const inheritedNames = useMemo(() => {
    const byId = new Map(objects.map(o => [o.id, o.name]));
    return deptObjectIds.map(id => byId.get(id)).filter((v): v is string => Boolean(v));
  }, [objects, deptObjectIds]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await adminService.updateEmployeeObjectAssignment(employee.id, current);
      await queryClient.invalidateQueries({ queryKey: ['admin-object-assignments'] });
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

  const renderItem = (obj: { id: string; name: string }) => {
    const checked = current.includes(obj.id);
    return (
      <label key={obj.id} className={`sc-obj-item ${checked ? 'sc-obj-item--on' : ''}`}>
        <input type="checkbox" checked={checked} onChange={() => toggle(obj.id)} />
        <span>{obj.name}</span>
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
            Персональное назначение объектов сотруднику — переопределяет объекты бригады.
            Объект с адресом «Текущая деятельность» в единой 1С-выгрузке идёт одной строкой
            без разбивки по объектам. Объекты на отделы/бригады назначаются массово через меню «•••».
          </p>

          {inheritedNames.length > 0 && (
            <div className="sc-field" style={{ fontSize: 13 }}>
              <label>Наследуется от бригады</label>
              <div style={{ color: 'var(--text-secondary, #64748b)' }}>{inheritedNames.join(', ')}</div>
            </div>
          )}

          {objects.length > 8 && (
            <input
              type="text"
              className="sc-obj-search"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Поиск объекта…"
            />
          )}

          {loading ? (
            <div style={{ fontSize: 14 }}>Загрузка…</div>
          ) : objects.length === 0 ? (
            <div style={{ fontSize: 14 }}>Объекты не настроены</div>
          ) : (
            <div className="sc-obj-list">
              <div className="sc-obj-group-label">Назначенные{assigned.length > 0 ? ` (${assigned.length})` : ''}</div>
              {assigned.length > 0
                ? assigned.map(renderItem)
                : <div className="sc-obj-empty">— нет персональных объектов —</div>}
              <div className="sc-obj-group-label">Доступные</div>
              {available.length > 0
                ? available.map(renderItem)
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
