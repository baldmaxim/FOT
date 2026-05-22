import { type FC, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { X, Save } from 'lucide-react';
import { useStructureTree } from '../../hooks/useStructure';
import { flattenDepartmentTree, filterDepartmentTree } from '../../utils/departmentUtils';
import { correctionApprovalService } from '../../services/correctionApprovalService';
import { useToast } from '../../contexts/ToastContext';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import './CorrectionApprovalSettingsModal.css';

interface IProps {
  onClose: () => void;
}

type TriState = 'none' | 'partial' | 'all';

interface ITriCheckboxProps {
  state: TriState;
  onChange: () => void;
  ariaLabel: string;
}

const TriCheckbox: FC<ITriCheckboxProps> = ({ state, onChange, ariaLabel }) => {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === 'partial';
  }, [state]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={state === 'all'}
      onChange={onChange}
      aria-label={ariaLabel}
    />
  );
};

/**
 * Настройка «Согласование выходных дней»: дерево отделов с галочками.
 * Отмеченным отделам требуется согласование работы в нерабочий день,
 * неотмеченным (включая бригады и новые отделы) — не требуется.
 */
export const CorrectionApprovalSettingsModal: FC<IProps> = ({ onClose }) => {
  const toast = useToast();
  const queryClient = useQueryClient();
  const overlayHandlers = useOverlayDismiss(onClose);

  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState<Set<string> | null>(null);

  const structureQuery = useStructureTree();
  const settingsQuery = useQuery({
    queryKey: ['correction-approval-settings'],
    queryFn: () => correctionApprovalService.getSettings(),
  });

  // Инициализация черновика из сохранённой настройки — один раз при загрузке
  // (паттерн «adjusting state during render», без setState-в-эффекте).
  if (draft === null && settingsQuery.data) {
    setDraft(new Set(settingsQuery.data.requiredDepartmentIds));
  }

  const departments = useMemo(
    () => structureQuery.data?.departments ?? [],
    [structureQuery.data],
  );

  // Полный плоский список (DFS-порядок) — источник для каскадного выбора.
  const fullFlat = useMemo(() => flattenDepartmentTree(departments), [departments]);

  // id → все потомки (по DFS-порядку: подряд идущие узлы с большим level).
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

  // Отображаемый список: при поиске — отфильтрованное дерево с предками-контейнерами.
  const visibleFlat = useMemo(() => {
    if (!search.trim()) return fullFlat;
    return flattenDepartmentTree(filterDepartmentTree(departments, search));
  }, [search, fullFlat, departments]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const initialSet = useMemo(
    () => new Set(settingsQuery.data?.requiredDepartmentIds ?? []),
    [settingsQuery.data],
  );

  const saveMutation = useMutation({
    mutationFn: (ids: string[]) => correctionApprovalService.saveSettings(ids),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['correction-approval-settings'] }),
        queryClient.invalidateQueries({ queryKey: ['correction-approvals'] }),
      ]);
      toast.success?.('Настройки согласования сохранены');
      onClose();
    },
    onError: (err) => toast.error?.(err instanceof Error ? err.message : 'Ошибка сохранения настроек'),
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
      if (allIn) {
        for (const g of group) next.delete(g);
      } else {
        for (const g of group) next.add(g);
      }
      return next;
    });
  };

  const selectAll = () => setDraft(new Set(fullFlat.map((d) => d.id)));
  const clearAll = () => setDraft(new Set());

  const loading = structureQuery.isLoading || settingsQuery.isLoading || draft === null;
  const errored = structureQuery.isError || settingsQuery.isError;

  const hasChanges =
    draft !== null
    && (draft.size !== initialSet.size || [...draft].some((id) => !initialSet.has(id)));

  const handleSave = () => {
    if (!draft || !hasChanges || saveMutation.isPending) return;
    saveMutation.mutate([...draft]);
  };

  return (
    <div className="approvals-modal-overlay" {...overlayHandlers}>
      <div className="approvals-modal casm-modal">
        <div className="approvals-modal-header">
          <h3>Согласование выходных дней по отделам</h3>
          <button
            type="button"
            className="approvals-modal-close"
            onClick={onClose}
            disabled={saveMutation.isPending}
            aria-label="Закрыть"
          >
            <X size={18} />
          </button>
        </div>

        <div className="approvals-modal-body casm-body">
          <p className="casm-hint">
            Отмеченным отделам требуется согласование работы в выходной/праздничный день.
            Неотмеченным (включая бригады) — корректировки утверждаются автоматически.
          </p>

          {errored ? (
            <div className="casm-empty">Не удалось загрузить структуру отделов</div>
          ) : loading ? (
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
                <span className="casm-count">
                  Выбрано отделов: <b>{draft?.size ?? 0}</b>
                </span>
                <div className="casm-bulk">
                  <button type="button" onClick={selectAll}>Отметить все</button>
                  <button type="button" onClick={clearAll}>Снять все</button>
                </div>
              </div>

              <div className="casm-tree">
                {visibleFlat.length === 0 ? (
                  <div className="casm-empty">
                    {search.trim() ? 'По запросу ничего не найдено' : 'Отделы не найдены'}
                  </div>
                ) : (
                  visibleFlat.map((item) => (
                    <label
                      key={item.id}
                      className={`casm-row${item.kind === 'brigade' ? ' casm-row--brigade' : ''}${item.kind === 'object' ? ' casm-row--object' : ''}`}
                      style={{ paddingLeft: `${item.level * 16 + 8}px` }}
                    >
                      <TriCheckbox
                        state={groupState(item.id)}
                        onChange={() => toggle(item.id)}
                        ariaLabel={`Согласование для «${item.name}»`}
                      />
                      <span className="casm-row-name">{item.name}</span>
                      {item.kind === 'brigade' && <span className="casm-badge">бригада</span>}
                      {item.kind === 'object' && <span className="casm-badge">объект</span>}
                    </label>
                  ))
                )}
              </div>
            </>
          )}
        </div>

        <div className="approvals-modal-footer">
          <button
            type="button"
            className="approvals-modal-cancel"
            onClick={onClose}
            disabled={saveMutation.isPending}
          >
            Отмена
          </button>
          <button
            type="button"
            className="casm-save"
            onClick={handleSave}
            disabled={loading || !hasChanges || saveMutation.isPending}
          >
            <Save size={16} />
            {saveMutation.isPending ? 'Сохранение…' : 'Сохранить'}
          </button>
        </div>
      </div>
    </div>
  );
};
