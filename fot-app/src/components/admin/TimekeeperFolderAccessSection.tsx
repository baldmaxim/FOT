import { type FC, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Save } from 'lucide-react';
import { useStructureTree } from '../../hooks/useStructure';
import { flattenDepartmentTree, filterDepartmentTree } from '../../utils/departmentUtils';
import { adminService } from '../../services/adminService';
import { useToast } from '../../contexts/ToastContext';
import styles from '../../pages/admin/Admin.module.css';
import '../../pages/approvals/CorrectionApprovalSettingsModal.css';

interface IProps {
  userId: string;
}

type TriState = 'none' | 'partial' | 'all';

const TriCheckbox: FC<{ state: TriState; onChange: () => void; ariaLabel: string }> = ({ state, onChange, ariaLabel }) => {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === 'partial';
  }, [state]);
  return (
    <input ref={ref} type="checkbox" checked={state === 'all'} onChange={onChange} aria-label={ariaLabel} />
  );
};

/**
 * Папки оргструктуры табельщицы: дерево с галочками (каскад на потомков).
 * Видимые табельщице участки/бригады = присутствие на её объектах ∩ поддерево
 * выбранных папок (миграция 165). Пустой набор = табельщица не видит никого.
 */
export const TimekeeperFolderAccessSection: FC<IProps> = ({ userId }) => {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState<Set<string> | null>(null);

  const structureQuery = useStructureTree();
  const savedQuery = useQuery({
    queryKey: ['admin-timekeeper-folders', userId],
    queryFn: () => adminService.getUserTimekeeperFolders(userId),
    staleTime: 30_000,
  });

  if (draft === null && savedQuery.data) {
    setDraft(new Set(savedQuery.data.department_ids));
  }

  const departments = useMemo(() => structureQuery.data?.departments ?? [], [structureQuery.data]);
  const fullFlat = useMemo(() => flattenDepartmentTree(departments), [departments]);

  const descendantsMap = useMemo(() => {
    const map = new Map<string, string[]>();
    for (let i = 0; i < fullFlat.length; i++) {
      const node = fullFlat[i];
      const desc: string[] = [];
      for (let j = i + 1; j < fullFlat.length; j++) {
        if (fullFlat[j].level <= node.level) break;
        desc.push(fullFlat[j].id);
      }
      map.set(node.id, desc);
    }
    return map;
  }, [fullFlat]);

  const visibleFlat = useMemo(() => {
    if (!search.trim()) return fullFlat;
    return flattenDepartmentTree(filterDepartmentTree(departments, search));
  }, [search, fullFlat, departments]);

  const initialSet = useMemo(() => new Set(savedQuery.data?.department_ids ?? []), [savedQuery.data]);

  const saveMutation = useMutation({
    mutationFn: (ids: string[]) => adminService.updateUserTimekeeperFolders(userId, ids),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['admin-timekeeper-folders', userId] });
      toast.success('Папки табельщицы обновлены');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Ошибка сохранения'),
  });

  const groupState = (id: string): TriState => {
    if (!draft) return 'none';
    const group = [id, ...(descendantsMap.get(id) ?? [])];
    let count = 0;
    for (const g of group) if (draft.has(g)) count++;
    if (count === 0) return 'none';
    if (count === group.length) return 'all';
    return 'partial';
  };

  const toggle = (id: string) => {
    const group = [id, ...(descendantsMap.get(id) ?? [])];
    setDraft((prev) => {
      const next = new Set(prev ?? []);
      const allIn = group.every((g) => next.has(g));
      if (allIn) for (const g of group) next.delete(g);
      else for (const g of group) next.add(g);
      return next;
    });
  };

  const loading = structureQuery.isLoading || savedQuery.isLoading || draft === null;
  const hasChanges = draft !== null
    && (draft.size !== initialSet.size || [...draft].some((id) => !initialSet.has(id)));

  return (
    <div>
      <div className={styles.companyAccessLabel}>Папки табельщицы</div>
      <div className={styles.companyAccessHint}>
        Табельщица видит только участки/бригады, которые присутствуют на её объектах И входят в отмеченные папки. Папки не выбраны — табель пуст.
      </div>

      {loading ? (
        <div className="casm-loading">Загрузка…</div>
      ) : (
        <>
          <input
            type="text"
            className="casm-search"
            placeholder="Поиск отдела…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="casm-toolbar">
            <span className="casm-count">Выбрано: <b>{draft?.size ?? 0}</b></span>
            <div className="casm-bulk">
              <button type="button" onClick={() => setDraft(new Set(fullFlat.map((d) => d.id)))}>Отметить все</button>
              <button type="button" onClick={() => setDraft(new Set())}>Снять все</button>
            </div>
          </div>
          <div className="casm-tree">
            {visibleFlat.length === 0 ? (
              <div className="casm-empty">{search.trim() ? 'Ничего не найдено' : 'Отделы не найдены'}</div>
            ) : (
              visibleFlat.map((item) => (
                <label
                  key={item.id}
                  className={`casm-row${item.kind === 'brigade' ? ' casm-row--brigade' : ''}${item.kind === 'object' ? ' casm-row--object' : ''}`}
                  style={{ paddingLeft: `${item.level * 16 + 8}px` }}
                >
                  <TriCheckbox state={groupState(item.id)} onChange={() => toggle(item.id)} ariaLabel={`Папка «${item.name}»`} />
                  <span className="casm-row-name">{item.name}</span>
                  {item.kind === 'brigade' && <span className="casm-badge">бригада</span>}
                  {item.kind === 'object' && <span className="casm-badge">объект</span>}
                </label>
              ))
            )}
          </div>
          <button
            type="button"
            className="casm-save"
            onClick={() => { if (draft && hasChanges) saveMutation.mutate([...draft]); }}
            disabled={!hasChanges || saveMutation.isPending}
          >
            <Save size={16} />
            {saveMutation.isPending ? 'Сохранение…' : 'Сохранить папки'}
          </button>
        </>
      )}
    </div>
  );
};
