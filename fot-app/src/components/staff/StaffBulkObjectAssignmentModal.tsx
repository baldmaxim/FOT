import { useMemo, useState, type FC } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { adminService, type IObjectAssignments } from '../../services/adminService';
import { useToast } from '../../contexts/ToastContext';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import { groupObjects, objectGroupLabelsForIds } from '../../utils/objectGroups';
import type { IFlatDepartmentOption } from '../../utils/departmentUtils';

interface IProps {
  departments: IFlatDepartmentOption[];
  onClose: () => void;
  onAssigned?: () => void;
}

const normalize = (s: string): string => s.toLowerCase().replace(/ё/g, 'е').trim();

const union = (a: string[], b: string[]): string[] => [...new Set([...a, ...b])];
const diff = (a: string[], b: Set<string>): string[] => a.filter(id => !b.has(id));

/**
 * Массовое назначение «объектов входа» отделам/бригадам (department_object_assignment).
 * Две колонки: слева отделы/бригады, справа объекты (по наименованию; «Текущая
 * деятельность» — один пункт). «Назначить» (добавить) или «Снять» по выбранным.
 */
export const StaffBulkObjectAssignmentModal: FC<IProps> = ({ departments, onClose, onAssigned }) => {
  const toast = useToast();
  const queryClient = useQueryClient();
  const dismiss = useOverlayDismiss(onClose);

  const [deptSearch, setDeptSearch] = useState('');
  const [objectSearch, setObjectSearch] = useState('');
  const [selectedDepts, setSelectedDepts] = useState<Set<string>>(new Set());
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

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
  const deptObjMap = assignmentsQuery.data?.department_objects ?? {};

  const filteredDepts = useMemo(() => {
    const q = normalize(deptSearch);
    if (!q) return departments;
    return departments.filter(d => normalize(d.name).includes(q));
  }, [departments, deptSearch]);

  const filteredGroups = useMemo(() => {
    const q = normalize(objectSearch);
    if (!q) return groups;
    return groups.filter(g => normalize(g.label).includes(q));
  }, [groups, objectSearch]);

  const toggleDept = (id: string) => {
    setSelectedDepts(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleGroup = (key: string) => {
    setSelectedGroups(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  // id всех объектов выбранных пунктов.
  const selectedObjectIds = useMemo(
    () => groups.filter(g => selectedGroups.has(g.key)).flatMap(g => g.objectIds),
    [groups, selectedGroups],
  );

  const canApply = selectedDepts.size > 0 && selectedGroups.size > 0 && !busy;

  const apply = async (mode: 'add' | 'remove') => {
    if (!canApply) return;
    setBusy(true);
    const objSet = new Set(selectedObjectIds);
    const nextByDept = new Map<string, string[]>();
    for (const deptId of selectedDepts) {
      const cur = deptObjMap[deptId] ?? [];
      nextByDept.set(deptId, mode === 'add' ? union(cur, selectedObjectIds) : diff(cur, objSet));
    }
    try {
      for (const [deptId, next] of nextByDept) {
        await adminService.updateDepartmentObjectAssignment(deptId, next);
      }
      // Оптимистично обновляем кэш — столбец «Объект» обновляется сразу.
      queryClient.setQueryData<IObjectAssignments>(['admin-object-assignments'], old => {
        if (!old) return old;
        const department_objects = { ...old.department_objects };
        for (const [deptId, next] of nextByDept) department_objects[deptId] = next;
        return { ...old, department_objects };
      });
      queryClient.invalidateQueries({ queryKey: ['admin-object-assignments'] });
      queryClient.invalidateQueries({ queryKey: ['timesheet'] });
      toast.success(
        mode === 'add'
          ? `Объекты назначены отделам: ${selectedDepts.size}`
          : `Объекты сняты у отделов: ${selectedDepts.size}`,
      );
      setSelectedGroups(new Set());
      onAssigned?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Ошибка сохранения');
    } finally {
      setBusy(false);
    }
  };

  const loading = objectsQuery.isLoading || assignmentsQuery.isLoading;

  return (
    <div className="sc-overlay" {...dismiss}>
      <div className="sc-modal sc-modal--wide" onClick={e => e.stopPropagation()}>
        <div className="sc-modal-header">
          <h3>Назначить объект на отделы/бригады</h3>
          <button className="sc-modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="sc-modal-body">
          <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--text-secondary, #64748b)' }}>
            Слева — отделы/бригады, справа — объекты. Отметьте нужное и нажмите «Назначить» (или
            «Снять»). Сотрудники отделов наследуют объект. «Текущая деятельность» → в единой
            1С-выгрузке одна строка на сотрудника без разбивки по объектам.
          </p>

          <div className="sc-obj-cols">
            <div className="sc-obj-col">
              <label className="sc-obj-col-label">Отделы и бригады{selectedDepts.size > 0 ? ` — выбрано ${selectedDepts.size}` : ''}</label>
              <input
                type="text"
                className="sc-obj-search"
                value={deptSearch}
                onChange={e => setDeptSearch(e.target.value)}
                placeholder="Поиск отдела/бригады…"
              />
              <div className="sc-obj-list">
                {filteredDepts.length === 0 ? (
                  <div className="sc-obj-empty">— не найдено —</div>
                ) : filteredDepts.map(d => {
                  const checked = selectedDepts.has(d.id);
                  const assignedCount = objectGroupLabelsForIds(objects, deptObjMap[d.id] ?? []).length;
                  return (
                    <label
                      key={d.id}
                      className={`sc-obj-item ${checked ? 'sc-obj-item--on' : ''}`}
                      style={{ paddingLeft: 10 + d.level * 14 }}
                    >
                      <input type="checkbox" checked={checked} onChange={() => toggleDept(d.id)} />
                      <span>
                        {d.name}
                        {d.kind === 'brigade' && <span className="sc-obj-badge">бр.</span>}
                        {assignedCount > 0 && <span className="sc-obj-count">{assignedCount}</span>}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="sc-obj-col">
              <label className="sc-obj-col-label">Объекты{selectedGroups.size > 0 ? ` — выбрано ${selectedGroups.size}` : ''}</label>
              {groups.length > 8 && (
                <input
                  type="text"
                  className="sc-obj-search"
                  value={objectSearch}
                  onChange={e => setObjectSearch(e.target.value)}
                  placeholder="Поиск объекта…"
                />
              )}
              {loading ? (
                <div style={{ fontSize: 14 }}>Загрузка…</div>
              ) : groups.length === 0 ? (
                <div style={{ fontSize: 14 }}>Объекты не настроены</div>
              ) : (
                <div className="sc-obj-list">
                  {filteredGroups.length === 0 ? (
                    <div className="sc-obj-empty">— не найдено —</div>
                  ) : filteredGroups.map(g => {
                    const checked = selectedGroups.has(g.key);
                    return (
                      <label key={g.key} className={`sc-obj-item ${checked ? 'sc-obj-item--on' : ''}`}>
                        <input type="checkbox" checked={checked} onChange={() => toggleGroup(g.key)} />
                        <span>
                          {g.label}
                          {g.objectIds.length > 1 && <span className="sc-obj-count">{g.objectIds.length}</span>}
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="sc-modal-footer">
          <button className="sc-btn cancel" onClick={onClose} disabled={busy}>Закрыть</button>
          <button className="sc-btn secondary" onClick={() => void apply('remove')} disabled={!canApply}>
            Снять
          </button>
          <button className="sc-btn apply" onClick={() => void apply('add')} disabled={!canApply}>
            {busy ? 'Сохранение…' : 'Назначить'}
          </button>
        </div>
      </div>
    </div>
  );
};
