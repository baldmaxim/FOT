import { useMemo, useState, type FC } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { adminService } from '../../services/adminService';
import { useToast } from '../../contexts/ToastContext';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
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
 * Выбираем несколько отделов + несколько объектов → «Назначить» (добавить) или «Снять».
 * Члены отдела наследуют объект; объект с адресом «Текущая деятельность» → в 1С-выгрузке
 * без разбивки по объектам.
 */
export const StaffBulkObjectAssignmentModal: FC<IProps> = ({ departments, onClose, onAssigned }) => {
  const toast = useToast();
  const queryClient = useQueryClient();
  const dismiss = useOverlayDismiss(onClose);

  const [deptSearch, setDeptSearch] = useState('');
  const [selectedDepts, setSelectedDepts] = useState<Set<string>>(new Set());
  const [selectedObjects, setSelectedObjects] = useState<Set<string>>(new Set());
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

  const objects = objectsQuery.data ?? [];
  const deptObjMap = assignmentsQuery.data?.department_objects ?? {};

  const filteredDepts = useMemo(() => {
    const q = normalize(deptSearch);
    if (!q) return departments;
    return departments.filter(d => normalize(d.name).includes(q));
  }, [departments, deptSearch]);

  const toggleDept = (id: string) => {
    setSelectedDepts(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleObject = (id: string) => {
    setSelectedObjects(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const canApply = selectedDepts.size > 0 && selectedObjects.size > 0 && !busy;

  const apply = async (mode: 'add' | 'remove') => {
    if (!canApply) return;
    setBusy(true);
    const objIds = [...selectedObjects];
    const objSet = new Set(objIds);
    try {
      for (const deptId of selectedDepts) {
        const cur = deptObjMap[deptId] ?? [];
        const next = mode === 'add' ? union(cur, objIds) : diff(cur, objSet);
        await adminService.updateDepartmentObjectAssignment(deptId, next);
      }
      await queryClient.invalidateQueries({ queryKey: ['admin-object-assignments'] });
      queryClient.invalidateQueries({ queryKey: ['timesheet'] });
      toast.success(
        mode === 'add'
          ? `Объекты назначены отделам: ${selectedDepts.size}`
          : `Объекты сняты у отделов: ${selectedDepts.size}`,
      );
      setSelectedObjects(new Set());
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
      <div className="sc-modal" onClick={e => e.stopPropagation()}>
        <div className="sc-modal-header">
          <h3>Назначить объект на отделы/бригады</h3>
          <button className="sc-modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="sc-modal-body">
          <p style={{ margin: '0 0 10px', fontSize: 13, color: 'var(--text-secondary, #64748b)' }}>
            Выберите отделы/бригады и объекты, затем «Назначить» (или «Снять»). Сотрудники отделов
            наследуют объект. Объект с адресом «Текущая деятельность» → в единой 1С-выгрузке одна
            строка на сотрудника без разбивки по объектам.
          </p>

          <div className="sc-field">
            <label>Отделы и бригады{selectedDepts.size > 0 ? ` — выбрано ${selectedDepts.size}` : ''}</label>
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
                const assignedCount = (deptObjMap[d.id] ?? []).length;
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

          <div className="sc-field">
            <label>Объекты{selectedObjects.size > 0 ? ` — выбрано ${selectedObjects.size}` : ''}</label>
            {loading ? (
              <div style={{ fontSize: 14 }}>Загрузка…</div>
            ) : objects.length === 0 ? (
              <div style={{ fontSize: 14 }}>Объекты не настроены</div>
            ) : (
              <div className="sc-obj-list">
                {objects.map(obj => {
                  const checked = selectedObjects.has(obj.id);
                  return (
                    <label key={obj.id} className={`sc-obj-item ${checked ? 'sc-obj-item--on' : ''}`}>
                      <input type="checkbox" checked={checked} onChange={() => toggleObject(obj.id)} />
                      <span>{obj.name}</span>
                    </label>
                  );
                })}
              </div>
            )}
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
