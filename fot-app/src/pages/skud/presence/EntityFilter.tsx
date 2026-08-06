import { useEffect, useMemo, useRef, useState, type FC } from 'react';
import { SearchIcon } from '../../../components/ui/Icons';
import styles from './SkudPresencePage.module.css';

export interface IEntityFilterOption {
  id: string;
  name: string;
  /** Заголовок группы (компания) — опции с одинаковым значением идут одним блоком. */
  group?: string | null;
}

interface IEntityFilterProps {
  label: string;
  searchPlaceholder: string;
  emptyText: string;
  allEntities: IEntityFilterOption[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onClear: () => void;
  isSynced?: (id: string) => boolean;
  /** Показывать заголовки групп с чекбоксом «выбрать все» (используется в выгрузке). */
  groupByGroup?: boolean;
  onToggleGroup?: (ids: string[], checked: boolean) => void;
}

export const EntityFilter: FC<IEntityFilterProps> = ({
  label,
  searchPlaceholder,
  emptyText,
  allEntities,
  selected,
  onToggle,
  onClear,
  isSynced,
  groupByGroup = false,
  onToggleGroup,
}) => {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Сброс поиска при закрытии — паттерн «состояние из прошлого рендера»
  // вместо setState-в-effect (react.dev «You Might Not Need an Effect»).
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (!open) setSearch('');
  }

  const selectedList = useMemo(
    () => allEntities.filter(c => selected.has(c.id)),
    [allEntities, selected],
  );

  const visibleEntities = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return allEntities;
    return allEntities.filter(c => c.name.toLowerCase().includes(q)
      || (c.group?.toLowerCase().includes(q) ?? false));
  }, [allEntities, search]);

  const groupedEntities = useMemo(() => {
    if (!groupByGroup) return null;
    const map = new Map<string, IEntityFilterOption[]>();
    for (const entity of visibleEntities) {
      const key = entity.group || '';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(entity);
    }
    return [...map.entries()];
  }, [groupByGroup, visibleEntities]);

  const renderRow = (entity: IEntityFilterOption) => {
    const isActive = selected.has(entity.id);
    const synced = isSynced?.(entity.id) ?? false;
    return (
      <label key={entity.id} className={styles.companyFilterRow}>
        <input
          type="checkbox"
          checked={isActive}
          onChange={() => onToggle(entity.id)}
        />
        <span
          className={synced ? styles.companyFilterRowSynced : undefined}
          title={isSynced ? (synced ? 'Синхронизирована с ФОТ' : 'Только в Sigur') : undefined}
        >
          {entity.name}
        </span>
      </label>
    );
  };

  return (
    <div className={styles.companyFilter} ref={wrapperRef}>
      <button
        type="button"
        className={`${styles.companyFilterToggle} ${open ? styles.companyFilterToggleOpen : ''}`}
        onClick={() => setOpen(prev => !prev)}
      >
        {label}
        {selected.size > 0 && <span className={styles.companyFilterBadge}>{selected.size}</span>}
        <span className={styles.companyFilterCaret} aria-hidden>▾</span>
      </button>

      {selectedList.map(entity => {
        const synced = isSynced?.(entity.id) ?? false;
        return (
          <button
            key={entity.id}
            type="button"
            className={`${styles.chip} ${styles.chipActive} ${synced ? styles.chipSynced : ''}`}
            onClick={() => onToggle(entity.id)}
            title="Убрать из фильтра"
          >
            {entity.name}
            <span className={styles.chipRemove} aria-hidden>×</span>
          </button>
        );
      })}

      {selected.size > 0 && (
        <button type="button" className={styles.chipClear} onClick={onClear}>
          Сбросить
        </button>
      )}

      {open && (
        <div className={styles.companyFilterPanel}>
          <div className={styles.companyFilterSearch}>
            <SearchIcon className={styles.companyFilterSearchIcon} />
            <input
              type="search"
              className={styles.companyFilterSearchInput}
              placeholder={searchPlaceholder}
              value={search}
              onChange={e => setSearch(e.target.value)}
              autoFocus
            />
          </div>
          {visibleEntities.length === 0 ? (
            <div className={styles.companyFilterEmpty}>
              {allEntities.length === 0 ? emptyText : 'Ничего не найдено'}
            </div>
          ) : groupedEntities ? (
            groupedEntities.map(([groupName, entities]) => {
              const ids = entities.map(e => e.id);
              const allChecked = ids.every(id => selected.has(id));
              return (
                <div key={groupName || '__no_group__'}>
                  <label className={`${styles.companyFilterRow} ${styles.companyFilterGroupRow}`}>
                    <input
                      type="checkbox"
                      checked={allChecked}
                      onChange={() => onToggleGroup?.(ids, !allChecked)}
                    />
                    <span>{groupName || 'Без компании'}</span>
                  </label>
                  {entities.map(renderRow)}
                </div>
              );
            })
          ) : (
            visibleEntities.map(renderRow)
          )}
        </div>
      )}
    </div>
  );
};
