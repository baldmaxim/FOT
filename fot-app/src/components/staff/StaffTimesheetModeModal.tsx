import { useEffect, useMemo, useState, type FC } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import {
  adminService,
  type TimesheetExportMode,
  type ITimesheetModeEmployee,
  type IObjectAssignments,
} from '../../services/adminService';
import { employeeService } from '../../services/employeeService';
import { useToast } from '../../contexts/ToastContext';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import {
  CURRENT_ACTIVITY_LABEL,
  groupObjects,
  groupSelectionState,
  objectGroupLabelsForIds,
  type IObjectGroup,
} from '../../utils/objectGroups';
import type { Employee } from '../../types';

interface IProps {
  employee: Employee;
  row: ITimesheetModeEmployee | undefined;
  /** Блок «Объекты для доступа табельщицы» — только админу: это управление доступом, не выгрузкой. */
  canManageObjects: boolean;
  onClose: () => void;
  onSaved?: () => void;
}

/** Безобъектные варианты. «Объект» отдельным пунктом не нужен — им становится выбор объекта ниже. */
const PLAIN_MODE_OPTIONS: Array<{ value: TimesheetExportMode; label: string; hint: string }> = [
  {
    value: 'current_activity',
    label: 'Текущая деятельность',
    hint: 'Одна строка, в колонке «Адрес объекта» — «Текущая деятельность».',
  },
  {
    value: 'skud',
    label: 'По СКУД',
    hint: 'Разбивка по фактическим проходам: сколько объектов посетил — столько строк.',
  },
];

const MODE_LABELS: Record<TimesheetExportMode, string> = {
  current_activity: 'Текущая деятельность',
  object: 'Объект',
  skud: 'По СКУД',
};

const SOURCE_HINTS: Record<string, string> = {
  employee_explicit: 'задан лично',
  department_explicit: 'унаследован от отдела',
  legacy_department: 'выведен из назначения объекта отделу',
  legacy_default: 'по умолчанию',
};

/**
 * Блок «Объекты сотрудника для доступа табельщицы» временно скрыт: это управление
 * доступом, а не выгрузкой, и ему нужен отдельный экран. Существующие назначения
 * продолжают действовать — скрыт только редактор. Вернуть = поставить true.
 */
const SHOW_EMPLOYEE_OBJECT_ASSIGNMENT = false;

const normalize = (s: string): string => s.toLowerCase().replace(/ё/g, 'е').trim();

const isCurrentActivityAddress = (altName: string | null | undefined): boolean =>
  normalize(altName ?? '') === normalize(CURRENT_ACTIVITY_LABEL);

const arraysEqual = (a: string[], b: string[]): boolean => {
  if (a.length !== b.length) return false;
  const x = [...a].sort();
  const y = [...b].sort();
  return x.every((v, i) => v === y[i]);
};

const setIndeterminate = (el: HTMLInputElement | null, value: boolean): void => {
  if (el) el.indeterminate = value;
};

/**
 * Персональная модалка колонки «Объект».
 *
 * Блока два, и они про разное — отсюда раздельные кнопки сохранения: общая создавала бы
 * иллюзию атомарной операции над двумя независимыми API.
 *   1. Режим табелирования 1С (employees.timesheet_export_mode) — влияет только на колонку
 *      «Адрес объекта» в выгрузке «Единый файл для 1С». Правит и HR.
 *   2. Объекты сотрудника (employee_object_assignment) — управление доступом: от них зависит
 *      скоуп табельщицы «сотрудники моих объектов». Только админ, и сейчас СКРЫТ —
 *      см. SHOW_EMPLOYEE_OBJECT_ASSIGNMENT.
 */
export const StaffTimesheetModeModal: FC<IProps> = ({ employee, row, canManageObjects, onClose, onSaved }) => {
  const toast = useToast();
  const queryClient = useQueryClient();
  const dismiss = useOverlayDismiss(onClose);
  const showObjects = canManageObjects && SHOW_EMPLOYEE_OBJECT_ASSIGNMENT;

  // ─────────────────────────── режим табелирования ───────────────────────────

  const [saving, setSaving] = useState(false);
  const [modeSearch, setModeSearch] = useState('');

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

  // null = «как у отдела»: явный режим снимается, работает режим отдела или legacy-фолбэк.
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

  const modeObjectsQuery = useQuery({
    queryKey: ['work-object-options'],
    queryFn: () => employeeService.listWorkObjectOptions(),
    staleTime: 5 * 60_000,
  });

  /**
   * Объекты для выбора режима. Записи с адресом «Текущая деятельность» отфильтрованы: им
   * соответствует отдельный режим current_activity, объект которому не нужен, а режим object
   * требует РОВНО один UUID (инвариант миграции 249).
   */
  const selectableObjects = useMemo(() => {
    const q = normalize(modeSearch);
    return (modeObjectsQuery.data ?? [])
      .filter(o => !isCurrentActivityAddress(o.alt_name))
      .filter(o => !q || normalize(o.name).includes(q))
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  }, [modeObjectsQuery.data, modeSearch]);

  const dirty = mode !== (loadedRow?.explicit_mode ?? null) || objectId !== (loadedRow?.explicit_object_id ?? null);
  const objectRequired = mode === 'object';
  const canSaveMode = rowReady && dirty && !saving && (!objectRequired || Boolean(objectId));

  const handleSaveMode = async (): Promise<void> => {
    setSaving(true);
    try {
      await adminService.updateEmployeeTimesheetMode(employee.id, mode, objectRequired ? objectId : null);
      // Режим влияет на выгрузку 1С — сбрасываем и режимы, и кэш табеля.
      await queryClient.invalidateQueries({ queryKey: ['admin-timesheet-modes'] });
      await queryClient.invalidateQueries({ queryKey: ['timesheet'] });
      toast.success('Режим табелирования сохранён');
      onSaved?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не удалось сохранить режим');
    } finally {
      setSaving(false);
    }
  };

  const effectiveHint = loadedRow
    ? `Сейчас: ${MODE_LABELS[loadedRow.effective_mode] ?? loadedRow.effective_mode}`
      + (loadedRow.effective_mode === 'object' && loadedRow.effective_object_name
        ? ` (${loadedRow.effective_object_name})`
        : '')
      + ` — ${SOURCE_HINTS[loadedRow.source] ?? loadedRow.source}`
    : '';

  // ───────────────────── объекты сотрудника (доступ табельщицы) ─────────────────────

  const departmentId = employee.org_department_id ?? null;
  const [objSaving, setObjSaving] = useState(false);
  const [draft, setDraft] = useState<string[] | null>(null);
  const [objSearch, setObjSearch] = useState('');

  const assignObjectsQuery = useQuery({
    queryKey: ['admin-skud-objects'],
    queryFn: () => adminService.listSkudObjectsForAssignment(),
    staleTime: 5 * 60_000,
    enabled: showObjects,
  });
  const assignmentsQuery = useQuery({
    queryKey: ['admin-object-assignments'],
    queryFn: () => adminService.getObjectAssignments(),
    staleTime: 30_000,
    enabled: showObjects,
  });

  const assignObjects = useMemo(() => assignObjectsQuery.data ?? [], [assignObjectsQuery.data]);
  const groups = useMemo(() => groupObjects(assignObjects), [assignObjects]);

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
  const objDirty = !arraysEqual(current, empObjectIds);

  const toggleGroup = (group: IObjectGroup): void => {
    const state = groupSelectionState(group, currentSet);
    setDraft(() => {
      const set = new Set(current);
      if (state === 'all') group.objectIds.forEach(id => set.delete(id));
      else group.objectIds.forEach(id => set.add(id));
      return [...set];
    });
  };

  const filteredGroups = useMemo(() => {
    const q = normalize(objSearch);
    if (!q) return groups;
    return groups.filter(g => normalize(g.label).includes(q));
  }, [groups, objSearch]);

  const assignedGroups = filteredGroups.filter(g => groupSelectionState(g, currentSet) !== 'none');
  const availableGroups = filteredGroups.filter(g => groupSelectionState(g, currentSet) === 'none');

  const inheritedLabels = useMemo(
    () => objectGroupLabelsForIds(assignObjects, deptObjectIds),
    [assignObjects, deptObjectIds],
  );

  const handleSaveObjects = async (): Promise<void> => {
    setObjSaving(true);
    try {
      const saved = [...current];
      await adminService.updateEmployeeObjectAssignment(employee.id, saved);
      // Оптимистично обновляем кэш назначений (глобально refetchOnMount:false, поэтому
      // не полагаемся только на invalidate).
      queryClient.setQueryData<IObjectAssignments>(['admin-object-assignments'], old => (
        old ? { ...old, employee_objects: { ...old.employee_objects, [String(employee.id)]: saved } } : old
      ));
      void queryClient.invalidateQueries({ queryKey: ['admin-object-assignments'] });
      // Кэш табеля не трогаем: с миграции 253 назначения объектов на режим выгрузки
      // не влияют, это только доступ табельщицы.
      toast.success('Персональные объекты обновлены');
      setDraft(null);
      onSaved?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Ошибка сохранения');
    } finally {
      setObjSaving(false);
    }
  };

  const objLoading = assignObjectsQuery.isLoading || assignmentsQuery.isLoading;

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
      <div className="sc-modal sc-modal--full sc-modal--pick" onClick={e => e.stopPropagation()}>
        <div className="sc-modal-header">
          <h3>Режим табелирования — {employee.full_name}</h3>
          <button className="sc-modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className={`sc-modal-body sc-mode-body ${showObjects ? 'sc-mode-body--pick3' : 'sc-mode-body--pick'}`}>
          <div className="sc-obj-col">
            <div className="sc-obj-col-label">Сотрудник</div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{employee.full_name}</div>
            <div style={{ fontSize: 13, lineHeight: 1.7, color: 'var(--text-secondary, #64748b)' }}>
              <div>Отдел — {employee.department || '—'}</div>
              <div>Должность — {employee.position_name || '—'}</div>
              <div>Таб. номер — {employee.tab_number || '—'}</div>
            </div>

            <div style={{ fontSize: 13 }}>
              {rowReady ? effectiveHint : 'Загрузка текущей настройки…'}
            </div>

            {objectRequired && loadedRow?.effective_object_is_active === false
              && objectId === loadedRow.explicit_object_id && (
              <div className="sc-obj-empty" style={{ fontSize: 12 }}>
                Текущий объект неактивен — выберите другой.
              </div>
            )}
          </div>

          <div className="sc-obj-col">
            <div className="sc-obj-col-label">Вариант табелирования</div>
            <input
              type="text"
              className="sc-obj-search"
              value={modeSearch}
              onChange={e => setModeSearch(e.target.value)}
              placeholder="Поиск объекта…"
            />

            <div className="sc-obj-list">
              <div className="sc-obj-group-label">Режим</div>
              <label className={`sc-obj-item ${mode === null ? 'sc-obj-item--on' : ''}`}>
                <input
                  type="radio"
                  name="employee-timesheet-mode"
                  checked={mode === null}
                  onChange={() => { setMode(null); setObjectId(null); }}
                />
                <span>
                  Как у отдела
                  <span className="sc-obj-empty" style={{ display: 'block', fontSize: 12 }}>
                    Личная настройка снимается — действует режим отдела.
                  </span>
                </span>
              </label>

              {PLAIN_MODE_OPTIONS.map(option => (
                <label key={option.value} className={`sc-obj-item ${mode === option.value ? 'sc-obj-item--on' : ''}`}>
                  <input
                    type="radio"
                    name="employee-timesheet-mode"
                    checked={mode === option.value}
                    onChange={() => { setMode(option.value); setObjectId(null); }}
                  />
                  <span>
                    {option.label}
                    <span className="sc-obj-empty" style={{ display: 'block', fontSize: 12 }}>{option.hint}</span>
                  </span>
                </label>
              ))}

              <div className="sc-obj-group-label">Объекты</div>
              {modeObjectsQuery.isLoading ? (
                <div style={{ fontSize: 14, padding: '8px 0' }}>Загрузка объектов…</div>
              ) : selectableObjects.length === 0 ? (
                <div className="sc-obj-empty">— объекты не найдены —</div>
              ) : selectableObjects.map(o => (
                <label
                  key={o.id}
                  className={`sc-obj-item ${mode === 'object' && objectId === o.id ? 'sc-obj-item--on' : ''}`}
                >
                  <input
                    type="radio"
                    name="employee-timesheet-mode"
                    checked={mode === 'object' && objectId === o.id}
                    onChange={() => { setMode('object'); setObjectId(o.id); }}
                  />
                  <span>{o.name}</span>
                </label>
              ))}
            </div>

            <p style={{ margin: 0, fontSize: 12, color: 'var(--text-secondary, #64748b)' }}>
              Определяет колонку «Адрес объекта» в выгрузке «Единый файл для 1С».
              На сам табель, СКУД и права не влияет.
            </p>
          </div>

          {showObjects && (
            <div className="sc-obj-col">
              <div className="sc-obj-col-label">Объекты сотрудника для доступа табельщицы</div>
              <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary, #64748b)' }}>
                Отдельная от режима настройка: от неё зависит, каких сотрудников видит табельщица.
                Переопределяет объекты бригады. На выгрузку 1С напрямую не влияет.
              </p>

              {inheritedLabels.length > 0 && (
                <div className="sc-field" style={{ fontSize: 13 }}>
                  <label>Наследуется от бригады</label>
                  <div style={{ color: 'var(--text-secondary, #64748b)' }}>{inheritedLabels.join(', ')}</div>
                </div>
              )}

              {assignObjects.length > 8 && (
                <input
                  type="text"
                  className="sc-obj-search"
                  value={objSearch}
                  onChange={e => setObjSearch(e.target.value)}
                  placeholder="Поиск по адресу…"
                />
              )}

              {objLoading ? (
                <div style={{ fontSize: 14 }}>Загрузка…</div>
              ) : groups.length === 0 ? (
                <div style={{ fontSize: 14 }}>Объекты не настроены</div>
              ) : (
                <div className="sc-obj-list">
                  <div className="sc-obj-group-label">
                    Назначенные{assignedGroups.length > 0 ? ` (${assignedGroups.length})` : ''}
                  </div>
                  {assignedGroups.length > 0
                    ? assignedGroups.map(renderGroup)
                    : <div className="sc-obj-empty">— нет персональных объектов —</div>}
                  <div className="sc-obj-group-label">Доступные</div>
                  {availableGroups.length > 0
                    ? availableGroups.map(renderGroup)
                    : <div className="sc-obj-empty">— все объекты назначены —</div>}
                </div>
              )}

              <div className="sc-modal-footer" style={{ padding: '10px 0 0', border: 0 }}>
                <button
                  className="sc-btn apply"
                  onClick={() => void handleSaveObjects()}
                  disabled={!objDirty || objSaving}
                >
                  <Check size={15} style={{ verticalAlign: 'text-bottom', marginRight: 4 }} />
                  {objSaving ? 'Сохранение…' : 'Сохранить объекты'}
                </button>
              </div>
            </div>
          )}
        </div>
        <div className="sc-modal-footer">
          <button className="sc-btn cancel" onClick={onClose} disabled={saving || objSaving}>Закрыть</button>
          <button className="sc-btn apply" onClick={() => void handleSaveMode()} disabled={!canSaveMode}>
            <Check size={15} style={{ verticalAlign: 'text-bottom', marginRight: 4 }} />
            {saving ? 'Сохранение…' : 'Сохранить вариант'}
          </button>
        </div>
      </div>
    </div>
  );
};
