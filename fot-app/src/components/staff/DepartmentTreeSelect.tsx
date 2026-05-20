import { useState, useMemo, useRef, useCallback, useEffect, useLayoutEffect, memo, type FC, type ChangeEvent, type KeyboardEvent, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import type { OrgDepartmentNode } from '../../types/organization';
import {
  getVisibleRootNodes,
  findDepartmentName,
  filterDepartmentTree,
  getDepartmentTypeMarker,
} from '../../utils/departmentUtils';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import styles from './DepartmentTreeSelect.module.css';

interface IDepartmentTreeSelectProps {
  /** Иерархия как из useStructureTree (НЕ плоская). Caller сам применяет
   *  filterDepartmentTreeByIds для managed-scope перед передачей. */
  departments: OrgDepartmentNode[];
  /** id выбранного отдела; '' = все. */
  value: string;
  onChange: (id: string) => void;
  isLoading?: boolean;
  isError?: boolean;
  onRetry?: () => void;
  /** Порог авто-раскрытия всего дерева (число выбираемых узлов). */
  autoExpandThreshold?: number;
  placeholder?: string;
  /** Показывать строку «Все отделы» (сброс). Default true. */
  showAllOption?: boolean;
}

const ALL_LABEL = 'Все отделы';

// Корень-компания (depth 0, есть дети) — только контейнер, не выбирается.
// Узел вне scope пользователя (in_scope=false) — серый предок.
// Корень без детей — выбираем (иначе по нему нельзя отфильтровать).
const isSelectableNode = (node: OrgDepartmentNode, depth: number): boolean => {
  const hasChildren = (node.children?.length ?? 0) > 0;
  if (depth === 0 && hasChildren) return false;
  return (node.in_scope ?? true) === true;
};

export const DepartmentTreeSelect: FC<IDepartmentTreeSelectProps> = memo(({
  departments,
  value,
  onChange,
  isLoading = false,
  isError = false,
  onRetry,
  autoExpandThreshold = 40,
  placeholder = 'Поиск отдела...',
  showAllOption = true,
}) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const [panelStyle, setPanelStyle] = useState<CSSProperties>({});

  const debounced = useDebouncedValue(query, 200).trim();

  const roots = useMemo(() => getVisibleRootNodes(departments), [departments]);
  const visibleTree = useMemo(() => filterDepartmentTree(roots, debounced), [roots, debounced]);
  const selectedName = useMemo(
    () => (value ? findDepartmentName(departments, value) : null),
    [departments, value],
  );

  // parentMap (child→parent в пределах roots), полный список id, число
  // выбираемых узлов — для стратегии раскрытия.
  const { parentMap, allNodeIds, selectableCount } = useMemo(() => {
    const pMap = new Map<string, string>();
    const ids: string[] = [];
    let selectable = 0;
    const walk = (node: OrgDepartmentNode, depth: number, parentId: string | null) => {
      ids.push(node.id);
      if (parentId) pMap.set(node.id, parentId);
      if (isSelectableNode(node, depth)) selectable += 1;
      node.children?.forEach(child => walk(child, depth + 1, node.id));
    };
    roots.forEach(node => walk(node, 0, null));
    return { parentMap: pMap, allNodeIds: ids, selectableCount: selectable };
  }, [roots]);

  const computeBaseExpansion = useCallback((): Set<string> => {
    // Узкий скоуп (мало узлов) — раскрыть всё: руководитель видит отделы сразу.
    if (selectableCount <= autoExpandThreshold) return new Set(allNodeIds);
    // Большое дерево — корни свёрнуты, но раскрыт путь к выбранному отделу.
    const path = new Set<string>();
    let cur = value ? parentMap.get(value) : undefined;
    while (cur) {
      if (path.has(cur)) break;
      path.add(cur);
      cur = parentMap.get(cur);
    }
    return path;
  }, [selectableCount, autoExpandThreshold, allNodeIds, parentMap, value]);

  const closePanel = useCallback(() => {
    setOpen(false);
    setQuery('');
    inputRef.current?.blur();
  }, []);

  const openPanel = useCallback(() => {
    if (open) return;
    setOpen(true);
    setQuery('');
    setExpanded(computeBaseExpansion());
  }, [open, computeBaseExpansion]);

  const overlay = useOverlayDismiss(closePanel);

  // Координаты для portal-панели — вычисляем по trigger при открытии и при resize/scroll.
  // На мобиле (<=430px) CSS перебивает inline-стили через !important.
  const updatePanelPosition = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPanelStyle({
      position: 'fixed',
      top: rect.bottom + 4,
      left: rect.left,
      minWidth: rect.width,
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updatePanelPosition();
  }, [open, updatePanelPosition]);

  useEffect(() => {
    if (!open) return;
    const handler = () => updatePanelPosition();
    window.addEventListener('resize', handler);
    window.addEventListener('scroll', handler, true);
    return () => {
      window.removeEventListener('resize', handler);
      window.removeEventListener('scroll', handler, true);
    };
  }, [open, updatePanelPosition]);

  const pick = useCallback((id: string) => {
    onChange(id);
    closePanel();
  }, [onChange, closePanel]);

  const toggleNode = useCallback((id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const handleInputChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    if (!open) openPanel();
    setQuery(e.target.value);
  }, [open, openPanel]);

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closePanel();
    }
  }, [closePanel]);

  const isNodeExpanded = useCallback(
    (id: string) => (debounced ? true : expanded.has(id)),
    [debounced, expanded],
  );

  const hasData = roots.length > 0;
  const showStaleBadge = isError && hasData;
  const showLoadingState = isLoading && !hasData;
  const showErrorState = isError && !hasData;
  const showEmpty = !showLoadingState && !showErrorState && visibleTree.length === 0;

  const renderNode = (node: OrgDepartmentNode, depth: number) => {
    const hasChildren = (node.children?.length ?? 0) > 0;
    const selectable = isSelectableNode(node, depth);
    const isHeader = !selectable && hasChildren;
    const nodeExpanded = isNodeExpanded(node.id);
    const marker = getDepartmentTypeMarker(node.name);
    const isActive = selectable && node.id === value;

    const onRowClick = () => {
      if (selectable) pick(node.id);
      else if (hasChildren) toggleNode(node.id);
    };

    return (
      <div key={node.id}>
        <div
          className={`${styles.row} ${isActive ? styles.rowActive : ''} ${isHeader ? styles.rowHeader : ''}`}
          style={{ paddingLeft: 12 + depth * 16 }}
          onClick={onRowClick}
        >
          {hasChildren ? (
            <span
              className={styles.toggle}
              onClick={e => { e.stopPropagation(); toggleNode(node.id); }}
              aria-label={nodeExpanded ? 'Свернуть' : 'Раскрыть'}
            >
              {nodeExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            </span>
          ) : (
            <span className={styles.togglePlaceholder} />
          )}
          <span className={styles.label}>
            {marker && <span className={styles.typeMarker}>{marker}</span>}
            {node.name}
          </span>
        </div>
        {hasChildren && nodeExpanded && (
          <div>{node.children.map(child => renderNode(child, depth + 1))}</div>
        )}
      </div>
    );
  };

  return (
    <div className={styles.wrapper}>
      <div ref={triggerRef} className={styles.trigger}>
        <input
          ref={inputRef}
          className={styles.input}
          value={open ? query : (selectedName ?? ALL_LABEL)}
          placeholder={placeholder}
          onChange={handleInputChange}
          onFocus={openPanel}
          onKeyDown={handleKeyDown}
          aria-label="Фильтр по отделу"
          aria-expanded={open}
        />
        <span className={styles.adornment}>
          {showStaleBadge && (
            <AlertTriangle size={12} aria-label="Данные могут быть устаревшими" />
          )}
          <ChevronDown size={14} />
        </span>
      </div>

      {open && createPortal(
        <>
          <div
            className={styles.backdrop}
            onMouseDown={overlay.onMouseDown}
            onMouseUp={overlay.onMouseUp}
            onMouseLeave={overlay.onMouseLeave}
            onTouchStart={overlay.onTouchStart}
            onTouchEnd={overlay.onTouchEnd}
          />
          <div className={styles.panel} style={panelStyle}>
            {showStaleBadge && (
              <div className={styles.staleBanner}>
                Показаны последние данные.
                {onRetry && (
                  <button type="button" className={styles.retry} onClick={onRetry}>
                    Обновить
                  </button>
                )}
              </div>
            )}
            <div className={styles.list}>
              {showAllOption && (
                <div
                  className={`${styles.allOption} ${!value ? styles.rowActive : ''}`}
                  onClick={() => pick('')}
                >
                  {ALL_LABEL}
                </div>
              )}
              {visibleTree.map(node => renderNode(node, 0))}
              {showLoadingState && (
                <div className={styles.empty}>Загрузка отделов...</div>
              )}
              {showErrorState && (
                <div className={styles.empty}>
                  Не удалось загрузить.
                  {onRetry && (
                    <button type="button" className={styles.retry} onClick={onRetry}>
                      Повторить
                    </button>
                  )}
                </div>
              )}
              {showEmpty && !showLoadingState && !showErrorState && (
                <div className={styles.empty}>Не найдено</div>
              )}
            </div>
          </div>
        </>,
        document.body,
      )}
    </div>
  );
});
