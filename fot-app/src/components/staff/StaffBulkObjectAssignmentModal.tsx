import { useMemo, useState, type FC } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { adminService, type IObjectAssignments } from '../../services/adminService';
import { useToast } from '../../contexts/ToastContext';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import { groupObjects, objectGroupLabelsForIds, groupSelectionState } from '../../utils/objectGroups';
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
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
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
  const deptObjMap = useMemo(
    () => assignmentsQuery.data?.department_objects ?? {},
    [assignmentsQuery.data],
  );

  // Нормализуем глубину дерева к 0 (скрытые корни дают постоянный сдвиг).
  const minLevel = useMemo(
    () => (departments.length ? Math.min(...departments.map(d => d.level)) : 0),
    [departments],
  );

  const searching = deptSearch.trim().length > 0;

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

  // self + потомки = смежные строки с большим level (список в depth-first порядке).
  const subtreeIds = useMemo(() => {
    const map = new Map<string, string[]>();
    for (let i = 0; i < departments.length; i++) {
      const d = departments[i];
      const ids = [d.id];
      for (let j = i + 1; j < departments.length && departments[j].level > d.level; j++) {
        ids.push(departments[j].id);
      }
      map.set(d.id, ids);
    }
    return map;
  }, [departments]);

  // Видимые строки: при поиске — плоский список совпадений; иначе — свёрнуто до
  // корней, раскрывается по `expanded` (узел уровня ≤ границы сбрасывает её по себе).
  const visibleDepts = useMemo(() => {
    if (searching) return filteredDepts;
    const out: IFlatDepartmentOption[] = [];
    let collapseDepth = Infinity;
    for (const d of departments) {
      if (d.level > collapseDepth) continue;
      out.push(d);
      collapseDepth = expanded.has(d.id) ? Infinity : d.level;
    }
    return out;
  }, [departments, expanded, searching, filteredDepts]);

  const toggleExpand = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // Клик по любому родителю отмечает/снимает всю ветку (self + потомки).
  const toggleDept = (id: string) => {
    setSelectedDepts(prev => {
      const ids = subtreeIds.get(id) ?? [id];
      const allOn = ids.every(x => prev.has(x));
      const next = new Set(prev);
      ids.forEach(x => (allOn ? next.delete(x) : next.add(x)));
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

  // Состояние группы объектов по выбранным отделам: 'all' — назначена всем,
  // 'partial' — части/частично, 'none' — никому. Для меток «назначено/частично».
  const groupStateBySelected = useMemo(() => {
    const m = new Map<string, 'all' | 'partial' | 'none'>();
    const sel = [...selectedDepts];
    if (sel.length === 0) return m;
    for (const g of groups) {
      let full = 0;
      let any = 0;
      for (const deptId of sel) {
        const st = groupSelectionState(g, new Set(deptObjMap[deptId] ?? []));
        if (st === 'all') { full++; any++; } else if (st === 'partial') { any++; }
      }
      m.set(g.key, full === sel.length ? 'all' : any > 0 ? 'partial' : 'none');
    }
    return m;
  }, [groups, selectedDepts, deptObjMap]);

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
                {visibleDepts.length === 0 ? (
                  <div className="sc-obj-empty">— не найдено —</div>
                ) : visibleDepts.map(d => {
                  const ids = subtreeIds.get(d.id) ?? [d.id];
                  const checked = ids.every(x => selectedDepts.has(x));
                  const indeterminate = !checked && ids.some(x => selectedDepts.has(x));
                  const labels = objectGroupLabelsForIds(objects, deptObjMap[d.id] ?? []);
                  const indentPx = (d.level - minLevel) * 16;
                  const showChevron = d.hasChildren && !searching;
                  const isOpen = expanded.has(d.id);
                  return (
                    <label
                      key={d.id}
                      className={`sc-obj-item ${checked || indeterminate ? 'sc-obj-item--on' : ''}`}
                      style={{ paddingLeft: 10 + indentPx, ['--depth-indent' as string]: `${indentPx}px` }}
                    >
                      {showChevron ? (
                        <button
                          type="button"
                          className="sc-obj-chev"
                          onClick={e => { e.preventDefault(); e.stopPropagation(); toggleExpand(d.id); }}
                          aria-label={isOpen ? 'Свернуть' : 'Развернуть'}
                        >
                          {isOpen ? '▾' : '▸'}
                        </button>
                      ) : (
                        <span className="sc-obj-chev sc-obj-chev--leaf" />
                      )}
                      <input
                        type="checkbox"
                        checked={checked}
                        ref={el => { if (el) el.indeterminate = indeterminate; }}
                        onChange={() => toggleDept(d.id)}
                      />
                      <span>
                        {d.name}
                        {d.kind === 'brigade' && <span className="sc-obj-badge">бр.</span>}
                        {labels.length > 0 && (
                          <span className="sc-obj-count" title={labels.join(', ')}>{labels.length}</span>
                        )}
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
                    const assignState = groupStateBySelected.get(g.key) ?? 'none';
                    return (
                      <label key={g.key} className={`sc-obj-item ${checked ? 'sc-obj-item--on' : ''}`}>
                        <input type="checkbox" checked={checked} onChange={() => toggleGroup(g.key)} />
                        <span>
                          {g.label}
                          {g.objectIds.length > 1 && <span className="sc-obj-count">{g.objectIds.length}</span>}
                        </span>
                        {assignState === 'all' && <span className="sc-obj-assigned">✓ назначено</span>}
                        {assignState === 'partial' && (
                          <span className="sc-obj-assigned sc-obj-assigned--partial">частично</span>
                        )}
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
