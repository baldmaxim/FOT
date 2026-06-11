/**
 * Модалка массового ДОБАВЛЕНИЯ точек доступа выбранным сотрудникам Sigur.
 *
 * Семантика только merge: выбранные точки добавляются к текущим у каждого
 * сотрудника, ничего не снимается. Прогресс по SSE. Связанные подрядные
 * пропуска синхронизируются на сервере (видно в «Подрядчики → Мониторинг»).
 */
import { useMemo, useState } from 'react';
import type { FC } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Search } from 'lucide-react';
import { sigurAdminService } from '../../../services/sigurAdminService';
import type { BulkAccessPointsProgressEvent } from '../../../services/sigurAdminService';
import { useOverlayDismiss } from '../../../hooks/useOverlayDismiss';
import { ProgressBar } from '../../ui/ProgressBar';
import type { AccessPointOption, SigurConnectionScope } from '../../../types';
import styles from './BulkAccessPointsModal.module.css';

interface IBulkAccessPointsModalProps {
  employeeIds: number[];
  connection?: SigurConnectionScope;
  onClose: () => void;
  onApplied: () => void;
}

interface IGroup {
  key: string;
  title: string;
  options: AccessPointOption[];
}

interface IProgressState {
  processed: number;
  total: number;
  failed: number;
  synced: number;
}

const groupOptions = (options: AccessPointOption[]): IGroup[] => {
  const groups = new Map<string, IGroup>();
  const sorted = [...options].sort((left, right) => left.name.localeCompare(right.name, 'ru'));
  for (const option of sorted) {
    if (option.id == null) continue;
    const title = option.objectName || 'Без объекта';
    const key = option.objectId || `unassigned:${title}`;
    const current = groups.get(key) || { key, title, options: [] };
    current.options.push(option);
    groups.set(key, current);
  }
  return [...groups.values()].sort((left, right) => {
    if (left.title === 'Без объекта') return 1;
    if (right.title === 'Без объекта') return -1;
    return left.title.localeCompare(right.title, 'ru');
  });
};

export const BulkAccessPointsModal: FC<IBulkAccessPointsModalProps> = ({
  employeeIds,
  connection,
  onClose,
  onApplied,
}) => {
  const [search, setSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState<IProgressState | null>(null);
  const [result, setResult] = useState<{ updated: number; syncedPasses: number; failedIds: number[]; warnings: string[] } | null>(null);
  const [error, setError] = useState('');

  const optionsQuery = useQuery({
    queryKey: ['sigur-bulk-access-points', connection ?? 'default'],
    queryFn: () => sigurAdminService.getAccessPointOptions(connection),
    staleTime: 5 * 60_000,
  });

  const filteredGroups = useMemo(() => {
    const all = optionsQuery.data ?? [];
    const term = search.trim().toLowerCase();
    const filtered = term
      ? all.filter(option =>
          option.name.toLowerCase().includes(term) ||
          (option.objectName || '').toLowerCase().includes(term))
      : all;
    return groupOptions(filtered);
  }, [optionsQuery.data, search]);

  const dismissGuard = saving ? () => undefined : onClose;
  const overlayHandlers = useOverlayDismiss(dismissGuard);

  const toggleOption = (id: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleGroup = (group: IGroup) => {
    const ids = group.options.map(option => option.id as number);
    const allSelected = ids.every(id => selectedIds.has(id));
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (allSelected) ids.forEach(id => next.delete(id));
      else ids.forEach(id => next.add(id));
      return next;
    });
  };

  const toggleCollapse = (key: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleSubmit = async () => {
    if (selectedIds.size === 0 || saving) return;
    setSaving(true);
    setError('');
    setProgress({ processed: 0, total: employeeIds.length, failed: 0, synced: 0 });
    try {
      const onProgress = (event: BulkAccessPointsProgressEvent) => {
        if (event.type === 'progress') {
          setProgress(prev => ({
            processed: event.processed,
            total: event.total,
            failed: (prev?.failed ?? 0) + (event.ok ? 0 : 1),
            synced: (prev?.synced ?? 0) + event.syncedPasses,
          }));
        }
      };
      const res = await sigurAdminService.bulkAddAccessPointsStream(
        employeeIds,
        [...selectedIds],
        onProgress,
        connection,
      );
      setResult({
        updated: res.updated,
        syncedPasses: res.syncedPasses,
        failedIds: res.failedIds,
        warnings: res.warnings,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось добавить точки доступа');
    } finally {
      setSaving(false);
    }
  };

  const handleDone = () => {
    if (result) onApplied();
    onClose();
  };

  return (
    <div className="ep-modal-overlay" {...overlayHandlers}>
      <div className="ep-modal" onClick={event => event.stopPropagation()}>
        <div className="ep-modal-header">
          <div className="ep-modal-heading">
            <div className="ep-modal-title">
              {`Добавить точки доступа — ${employeeIds.length} сотр.`}
            </div>
          </div>
        </div>

        <div className="ep-modal-body">
          {result ? (
            <div className={styles.summary}>
              <div>Обновлено сотрудников: <b>{result.updated}</b></div>
              <div>Синхронизировано пропусков подрядчиков: <b>{result.syncedPasses}</b></div>
              {result.failedIds.length > 0 && (
                <div>Ошибок: <b>{result.failedIds.length}</b></div>
              )}
              {result.warnings.length > 0 && (
                <ul className={styles.warnings}>
                  {result.warnings.map((warning, index) => (
                    <li key={index}>{warning}</li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <>
              <div className={`ep-toolbar-search ${styles.search}`}>
                <Search size={14} />
                <input
                  type="text"
                  value={search}
                  onChange={event => setSearch(event.target.value)}
                  placeholder="Поиск точки или объекта..."
                  disabled={saving}
                />
              </div>

              <div className={styles.list}>
                {optionsQuery.isLoading ? (
                  <div className={styles.empty}>Загрузка точек доступа…</div>
                ) : filteredGroups.length === 0 ? (
                  <div className={styles.empty}>Ничего не найдено</div>
                ) : (
                  filteredGroups.map(group => {
                    const ids = group.options.map(option => option.id as number);
                    const allSelected = ids.every(id => selectedIds.has(id));
                    const someSelected = ids.some(id => selectedIds.has(id));
                    const isCollapsed = collapsed.has(group.key);
                    return (
                      <div className={styles.group} key={group.key}>
                        <div className={styles.groupHeader}>
                          <input
                            type="checkbox"
                            checked={allSelected}
                            ref={node => { if (node) node.indeterminate = !allSelected && someSelected; }}
                            onChange={() => toggleGroup(group)}
                            disabled={saving}
                            onClick={event => event.stopPropagation()}
                          />
                          <span className={styles.groupLabel} onClick={() => toggleCollapse(group.key)}>
                            {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                            {`${group.title} (${group.options.length})`}
                          </span>
                        </div>
                        {!isCollapsed && group.options.map(option => (
                          <label className={styles.row} key={option.id}>
                            <input
                              type="checkbox"
                              checked={selectedIds.has(option.id as number)}
                              onChange={() => toggleOption(option.id as number)}
                              disabled={saving}
                            />
                            <span>{option.name}</span>
                          </label>
                        ))}
                      </div>
                    );
                  })
                )}
              </div>

              <div className={styles.selection}>{`Выбрано точек: ${selectedIds.size}`}</div>

              {saving && progress && (
                <ProgressBar
                  label={progress.failed > 0
                    ? `Добавление точек (ошибок: ${progress.failed})`
                    : 'Добавление точек доступа'}
                  current={progress.processed}
                  total={progress.total}
                />
              )}

              {error && <div className={styles.error}>{error}</div>}
            </>
          )}
        </div>

        <div className="ep-modal-footer">
          {result ? (
            <button className="ep-modal-btn primary" onClick={handleDone}>
              Готово
            </button>
          ) : (
            <>
              <button className="ep-modal-btn secondary" onClick={onClose} disabled={saving}>
                Отмена
              </button>
              <button
                className="ep-modal-btn primary"
                onClick={handleSubmit}
                disabled={saving || selectedIds.size === 0}
              >
                {saving ? 'Добавление…' : 'Добавить'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
