import { type FC, useMemo, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Minus } from 'lucide-react';
import type { OrgDepartmentNode } from '../../types/organization';
import { filterDepartmentTree } from '../../utils/departmentUtils';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import styles from './DepartmentTreeMultiSelect.module.css';

interface IProps {
  /** Дерево отделов (например поддерево СУ-10 без бригад). */
  nodes: OrgDepartmentNode[];
  value: string[];
  onChange: (ids: string[]) => void;
  isLoading?: boolean;
  placeholder?: string;
}

const subtreeIds = (node: OrgDepartmentNode): string[] => {
  const out = [node.id];
  node.children?.forEach(c => out.push(...subtreeIds(c)));
  return out;
};

type NodeState = 'full' | 'partial' | 'none';

export const DepartmentTreeMultiSelect: FC<IProps> = ({
  nodes, value, onChange, isLoading = false, placeholder = 'Выберите отделы…',
}) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const debounced = useDebouncedValue(query, 200).trim();
  const selected = useMemo(() => new Set(value), [value]);

  const visible = useMemo(() => filterDepartmentTree(nodes, debounced), [nodes, debounced]);

  // Каскад: toggle узла переключает весь его поддерево.
  const toggle = (node: OrgDepartmentNode): void => {
    const ids = subtreeIds(node);
    const next = new Set(selected);
    if (selected.has(node.id)) ids.forEach(id => next.delete(id));
    else ids.forEach(id => next.add(id));
    onChange([...next]);
  };

  const toggleExpand = (id: string): void => setExpanded(prev => {
    const n = new Set(prev);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  const nodeState = (node: OrgDepartmentNode): NodeState => {
    const ids = subtreeIds(node);
    const sel = ids.reduce((acc, id) => acc + (selected.has(id) ? 1 : 0), 0);
    if (sel === 0) return 'none';
    return sel === ids.length ? 'full' : 'partial';
  };

  const renderNode = (node: OrgDepartmentNode, depth: number) => {
    const hasChildren = (node.children?.length ?? 0) > 0;
    const isExpanded = debounced ? true : expanded.has(node.id);
    const state = nodeState(node);
    return (
      <div key={node.id}>
        <div className={styles.row} style={{ paddingLeft: 6 + depth * 16 }}>
          {hasChildren ? (
            <button type="button" className={styles.chev} onClick={() => toggleExpand(node.id)} aria-label="Развернуть">
              {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
          ) : <span className={styles.chevSpacer} />}
          <button type="button" className={styles.item} onClick={() => toggle(node)}>
            <span className={`${styles.box} ${state === 'full' ? styles.boxFull : state === 'partial' ? styles.boxPartial : ''}`}>
              {state === 'full' && <Check size={12} />}
              {state === 'partial' && <Minus size={12} />}
            </span>
            <span className={styles.name}>{node.name}</span>
          </button>
        </div>
        {hasChildren && isExpanded && node.children!.map(c => renderNode(c, depth + 1))}
      </div>
    );
  };

  return (
    <div className={styles.wrap}>
      <button type="button" className={styles.trigger} onClick={() => setOpen(o => !o)}>
        <span>{value.length ? `Выбрано отделов: ${value.length}` : placeholder}</span>
        <ChevronDown size={16} className={open ? styles.chevOpen : ''} />
      </button>
      {open && (
        <div className={styles.panel}>
          <input
            className={styles.search}
            placeholder="Поиск отдела…"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
          <div className={styles.list}>
            {isLoading
              ? <div className={styles.empty}>Загрузка…</div>
              : visible.length
                ? visible.map(n => renderNode(n, 0))
                : <div className={styles.empty}>Ничего не найдено</div>}
          </div>
        </div>
      )}
    </div>
  );
};
