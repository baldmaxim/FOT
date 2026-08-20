import { useMemo, useState, type FC } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import {
  adminService,
  type TimesheetExportMode,
  type ITimesheetModeDepartment,
} from '../../services/adminService';
import { employeeService } from '../../services/employeeService';
import { useToast } from '../../contexts/ToastContext';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import type { IFlatDepartmentOption } from '../../utils/departmentUtils';
import { CURRENT_ACTIVITY_LABEL } from '../../utils/objectGroups';

interface IProps {
  /** Плоское дерево из StaffControlPage — уже с учётом скоупа пользователя. */
  departments: IFlatDepartmentOption[];
  onClose: () => void;
}

/** null = «не задавать» (вернуть отдел к legacy). undefined = режим ещё не выбран. */
type ModeChoice = TimesheetExportMode | null;

/**
 * Безобъектные варианты правой колонки. «Объект» отдельным пунктом не нужен — им становится
 * выбор конкретного объекта ниже по списку. Сброс явного режима делает кнопка в футере,
 * поэтому пункта «Не задавать» здесь тоже нет: случайный клик по списку не должен очищать
 * настройку целого поддерева.
 */
const PLAIN_MODE_OPTIONS: Array<{ value: TimesheetExportMode; label: string; hint: string }> = [
  { value: 'current_activity', label: 'Текущая деятельность', hint: 'Одна строка, адрес «Текущая деятельность».' },
  { value: 'skud', label: 'По СКУД', hint: 'Разбивка по фактическим проходам — несколько строк.' },
];

const MODE_BADGE: Record<TimesheetExportMode, string> = {
  current_activity: 'ТД',
  object: 'Объект',
  skud: 'СКУД',
};

const BATCH_LIMIT = 500;

const normalize = (s: string): string => s.toLowerCase().replace(/ё/g, 'е').trim();

/**
 * Массовая установка режима табелирования отделам и бригадам (миграция 249).
 *
 * Режим ставится подразделению; сотрудники наследуют его автоматически. Персональные
 * режимы сотрудников операция НЕ трогает — точечные исключения должны переживать
 * массовую настройку.
 */
export const StaffDepartmentsTimesheetModeModal: FC<IProps> = ({ departments, onClose }) => {
  const toast = useToast();
  const queryClient = useQueryClient();
  const dismiss = useOverlayDismiss(onClose);

  const [search, setSearch] = useState('');
  const [kindFilter, setKindFilter] = useState<'all' | 'department' | 'brigade'>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // undefined — режим не выбран. По умолчанию НЕ «не задавать»: иначе одно неверное
  // нажатие «Применить» молча очистило бы существующие настройки.
  const [mode, setMode] = useState<ModeChoice | undefined>(undefined);
  const [objectId, setObjectId] = useState<string | null>(null);
  const [objectSearch, setObjectSearch] = useState('');
  const [busy, setBusy] = useState(false);

  const modesQuery = useQuery({
    queryKey: ['admin-timesheet-mode-departments'],
    queryFn: () => adminService.listTimesheetModeDepartments(),
    staleTime: 30_000,
  });
  const objectsQuery = useQuery({
    queryKey: ['work-object-options'],
    queryFn: () => employeeService.listWorkObjectOptions(),
    staleTime: 5 * 60_000,
  });

  /**
   * Объекты для правой колонки. Записи с адресом «Текущая деятельность» отфильтрованы:
   * им соответствует отдельный режим current_activity, объект которому не нужен, а режим
   * object требует РОВНО один UUID (инвариант миграции 249). groupObjects() их не убирает,
   * а сворачивает в группу из нескольких id — для выбора режима это не подходит.
   */
  const selectableObjects = useMemo(() => {
    const isCurrentActivity = (name: string | null | undefined): boolean =>
      (name ?? '').toLowerCase().replace(/ё/g, 'е').trim() === CURRENT_ACTIVITY_LABEL.toLowerCase();
    const q = normalize(objectSearch);
    return (objectsQuery.data ?? [])
      .filter(o => !isCurrentActivity(o.alt_name))
      .filter(o => !q || normalize(o.name).includes(q))
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  }, [objectsQuery.data, objectSearch]);

  const modeById = useMemo(() => {
    const map = new Map<string, ITimesheetModeDepartment>();
    for (const row of modesQuery.data ?? []) map.set(row.id, row);
    return map;
  }, [modesQuery.data]);

  // В allDepts есть служебные узлы kind: 'object' и контейнеры-предки с inScope: false —
  // их нельзя ни показывать, ни выбирать. Плюс пересечение с серверным списком: только то,
  // что реально доступно на бэкенде.
  const selectable = useMemo(
    () => departments.filter(d => d.inScope && (d.kind === 'department' || d.kind === 'brigade') && modeById.has(d.id)),
    [departments, modeById],
  );

  // self + потомки: смежные строки с большим level (список в depth-first порядке).
  // Считается по ПОЛНОМУ списку, поэтому выбор родителя захватывает ветку независимо
  // от поиска и раскрытия.
  const subtreeIds = useMemo(() => {
    const map = new Map<string, string[]>();
    const allowed = new Set(selectable.map(d => d.id));
    for (let i = 0; i < departments.length; i++) {
      const d = departments[i];
      const ids: string[] = [];
      if (allowed.has(d.id)) ids.push(d.id);
      for (let j = i + 1; j < departments.length && departments[j].level > d.level; j++) {
        if (allowed.has(departments[j].id)) ids.push(departments[j].id);
      }
      map.set(d.id, [...new Set(ids)]);
    }
    return map;
  }, [departments, selectable]);

  const searching = search.trim().length > 0;

  const filtered = useMemo(() => {
    const q = normalize(search);
    return selectable.filter(d => {
      if (kindFilter !== 'all' && d.kind !== kindFilter) return false;
      return !q || normalize(d.name).includes(q);
    });
  }, [selectable, search, kindFilter]);

  const visible = useMemo(() => {
    if (searching || kindFilter !== 'all') return filtered;
    const out: IFlatDepartmentOption[] = [];
    let collapseDepth = Infinity;
    for (const d of selectable) {
      if (d.level > collapseDepth) continue;
      out.push(d);
      collapseDepth = expanded.has(d.id) ? Infinity : d.level;
    }
    return out;
  }, [selectable, expanded, searching, kindFilter, filtered]);

  const toggleExpand = (id: string): void => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleDept = (id: string): void => {
    setSelected(prev => {
      const ids = subtreeIds.get(id) ?? [id];
      const allOn = ids.every(x => prev.has(x));
      const next = new Set(prev);
      ids.forEach(x => (allOn ? next.delete(x) : next.add(x)));
      return next;
    });
  };

  // mode === undefined — режим справа ещё не выбран: «Назначить» остаётся заблокированной,
  // иначе одно случайное нажатие применило бы null и очистило настройку поддерева.
  const objectRequired = mode === 'object';
  const canApply = selected.size > 0
    && mode !== undefined
    && mode !== null
    && !busy
    && (!objectRequired || Boolean(objectId))
    && selected.size <= BATCH_LIMIT;

  /**
   * `nextMode: null` — сброс явного режима. Он намеренно НЕ смотрит на выбор справа:
   * иначе «Сбросить» вело бы себя по-разному в зависимости от того, что отмечено в списке.
   */
  const applyMode = async (nextMode: ModeChoice): Promise<void> => {
    if (selected.size > BATCH_LIMIT) {
      toast.error(`Выбрано ${selected.size} подразделений — максимум ${BATCH_LIMIT} за раз`);
      return;
    }
    setBusy(true);
    try {
      const result = await adminService.bulkUpdateDepartmentTimesheetModes(
        [...selected],
        nextMode,
        nextMode === 'object' ? objectId : null,
      );
      await queryClient.invalidateQueries({ queryKey: ['admin-timesheet-mode-departments'] });
      await queryClient.invalidateQueries({ queryKey: ['admin-timesheet-modes'] });
      await queryClient.invalidateQueries({ queryKey: ['timesheet'] });
      toast.success(
        nextMode === null
          ? `Явный режим сброшен: подразделений ${result.affected}`
          : `Режим применён: подразделений ${result.affected}`,
      );
      setSelected(new Set());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Не удалось применить режим');
    } finally {
      setBusy(false);
    }
  };

  /** Сброс массово возвращает подразделения к легаси-фолбэку — спрашиваем подтверждение. */
  const handleReset = (): void => {
    const ok = window.confirm(
      `Сбросить явный режим у выбранных подразделений (${selected.size})?
`
      + 'Они вернутся к режиму по умолчанию — тому, что даёт назначение объектов.',
    );
    if (ok) void applyMode(null);
  };

  const minLevel = useMemo(
    () => (selectable.length ? Math.min(...selectable.map(d => d.level)) : 0),
    [selectable],
  );

  const renderRow = (d: IFlatDepartmentOption) => {
    const row = modeById.get(d.id);
    const isOn = selected.has(d.id);
    const indent = searching || kindFilter !== 'all' ? 0 : (d.level - minLevel) * 14;
    return (
      <label key={d.id} className={`sc-obj-item ${isOn ? 'sc-obj-item--on' : ''}`} style={{ paddingLeft: 8 + indent }}>
        <input type="checkbox" checked={isOn} onChange={() => toggleDept(d.id)} />
        <span>
          {!searching && kindFilter === 'all' && d.hasChildren && (
            <button
              type="button"
              className="sc-inline-btn"
              title={expanded.has(d.id) ? 'Свернуть' : 'Раскрыть'}
              onClick={e => { e.preventDefault(); e.stopPropagation(); toggleExpand(d.id); }}
            >
              {expanded.has(d.id) ? '−' : '+'}
            </button>
          )}
          {d.name}
          {row && (
            <span
              className="sc-obj-badge"
              title={row.mode ? 'Режим задан явно' : 'Режим не задан — показан фактический (legacy)'}
            >
              {MODE_BADGE[row.effective_mode]}{row.mode ? '' : ' (legacy)'}
            </span>
          )}
          {row?.mode === 'object' && row.object_name && (
            <span className="sc-obj-count">{row.object_name}</span>
          )}
        </span>
      </label>
    );
  };

  return (
    <div className="sc-overlay" {...dismiss}>
      <div className="sc-modal sc-modal--full" onClick={e => e.stopPropagation()}>
        <div className="sc-modal-header">
          <h3>Режим табелирования для отделов/бригад</h3>
          <button className="sc-modal-close" onClick={onClose}>&times;</button>
        </div>

        <div className="sc-modal-body sc-mode-body">
          <div className="sc-obj-col">
            <div className="sc-obj-col-label">
              Отделы и бригады{selected.size > 0 ? ` — выбрано ${selected.size}` : ''}
            </div>
            <input
              type="text"
              className="sc-obj-search"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Поиск по названию…"
            />
            <div className="sc-mode-kind-filter">
              {([['all', 'Все'], ['department', 'Отделы'], ['brigade', 'Бригады']] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={`sc-btn ${kindFilter === value ? 'apply' : 'cancel'}`}
                  onClick={() => setKindFilter(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            {modesQuery.isLoading ? (
              <div style={{ fontSize: 14 }}>Загрузка…</div>
            ) : visible.length === 0 ? (
              <div className="sc-obj-empty">— ничего не найдено —</div>
            ) : (
              <div className="sc-obj-list">{visible.map(renderRow)}</div>
            )}
          </div>

          <div className="sc-obj-col">
            <div className="sc-obj-col-label">Вариант табелирования</div>
            <input
              type="text"
              className="sc-obj-search"
              value={objectSearch}
              onChange={e => setObjectSearch(e.target.value)}
              placeholder="Поиск объекта…"
            />
            <div className="sc-obj-list">
              <div className="sc-obj-group-label">Режим</div>
              {PLAIN_MODE_OPTIONS.map(option => (
                <label
                  key={option.value}
                  className={`sc-obj-item ${mode === option.value ? 'sc-obj-item--on' : ''}`}
                >
                  <input
                    type="radio"
                    name="bulk-timesheet-mode"
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
              {objectsQuery.isLoading ? (
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
                    name="bulk-timesheet-mode"
                    checked={mode === 'object' && objectId === o.id}
                    onChange={() => { setMode('object'); setObjectId(o.id); }}
                  />
                  <span>{o.name}</span>
                </label>
              ))}
            </div>

            <p style={{ marginTop: 12, fontSize: 13, color: 'var(--text-secondary, #64748b)' }}>
              Режим применяется к подразделению — сотрудники наследуют его. Персональные режимы,
              заданные отдельным людям, сохраняются и продолжают действовать.
            </p>
          </div>
        </div>

        <div className="sc-modal-footer">
          <button className="sc-btn cancel" onClick={onClose} disabled={busy}>Закрыть</button>
          <button
            className="sc-btn secondary"
            onClick={handleReset}
            disabled={busy || selected.size === 0}
            title="Вернуть выбранные подразделения к режиму по умолчанию"
          >
            Сбросить явный режим
          </button>
          <button className="sc-btn apply" onClick={() => void applyMode(mode ?? null)} disabled={!canApply}>
            <Check size={15} style={{ verticalAlign: 'text-bottom', marginRight: 4 }} />
            {busy ? 'Применение…' : `Назначить (${selected.size})`}
          </button>
        </div>
      </div>
    </div>
  );
};
