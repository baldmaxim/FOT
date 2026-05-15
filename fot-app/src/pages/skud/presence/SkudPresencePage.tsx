import { useMemo, useState, useRef, useEffect, type FC } from 'react';
import { usePresenceByObjectQuery } from '../../../hooks/useEmployeeDirectory';
import { MapPinIcon, UsersIcon, SearchIcon, BuildingIcon } from '../../../components/ui/Icons';
import type {
  IPresenceByObjectResponse,
  IPresenceObjectBucket,
  IPresenceObjectCompany,
  IPresenceObjectEmployee,
} from '../../../types';
import { ObjectDetailsModal } from './ObjectDetailsModal';
import { ObjectDetailView } from './ObjectDetailView';
import { isSyncedCompanyId } from './companyId.utils';
import styles from './SkudPresencePage.module.css';

const TOP_COMPANIES_LIMIT = 5;

const matchesEmployee = (emp: IPresenceObjectEmployee, query: string): boolean => {
  if (!query) return true;
  const normalized = query.toLowerCase();
  return emp.full_name.toLowerCase().includes(normalized)
    || (emp.position_name?.toLowerCase().includes(normalized) ?? false)
    || (emp.department_name?.toLowerCase().includes(normalized) ?? false);
};

interface IFilteredBucket extends Omit<IPresenceObjectBucket, 'companies'> {
  companies: IPresenceObjectCompany[];
}

const filterData = (
  data: IPresenceByObjectResponse | undefined,
  search: string,
  selectedCompanyIds: Set<string>,
  hideEmpty: boolean,
): {
  buckets: IFilteredBucket[];
  totalOnline: number;
  filteredCount: number;
} => {
  if (!data) return { buckets: [], totalOnline: 0, filteredCount: 0 };
  const hasCompanyFilter = selectedCompanyIds.size > 0;

  const buckets: IFilteredBucket[] = [];
  let filteredCount = 0;

  for (const bucket of data.buckets) {
    const filteredCompanies: IPresenceObjectCompany[] = [];
    let bucketTotal = 0;

    for (const company of bucket.companies) {
      if (hasCompanyFilter && !selectedCompanyIds.has(company.company_id)) continue;
      const matched = company.employees.filter(emp => matchesEmployee(emp, search));
      if (matched.length === 0 && (search || hasCompanyFilter)) continue;
      filteredCompanies.push({ ...company, online_count: matched.length, employees: matched });
      bucketTotal += matched.length;
      filteredCount += matched.length;
    }

    const hideThis = hideEmpty && bucketTotal === 0 && (search !== '' || hasCompanyFilter);
    if (hideThis) continue;
    if (hideEmpty && bucketTotal === 0 && !search && !hasCompanyFilter) continue;

    buckets.push({ ...bucket, companies: filteredCompanies, online_count: bucketTotal });
  }

  return { buckets, totalOnline: data.total_online, filteredCount };
};

const pluralCompanies = (n: number): string => {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'компания';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'компании';
  return 'компаний';
};

const ObjectCard: FC<{
  bucket: IFilteredBucket;
  onOpenDetails: (bucket: IFilteredBucket) => void;
}> = ({ bucket, onOpenDetails }) => {
  const visibleCompanies = bucket.companies.slice(0, TOP_COMPANIES_LIMIT);
  const restCompanies = bucket.companies.slice(TOP_COMPANIES_LIMIT);
  const restEmployees = restCompanies.reduce((sum, c) => sum + c.online_count, 0);

  return (
    <article
      className={`${styles.card} ${styles.cardClickable}`}
      onClick={() => onOpenDetails(bucket)}
      role="button"
      tabIndex={0}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpenDetails(bucket);
        }
      }}
    >
      <div className={styles.cardHeader}>
        <div className={styles.cardTitle}>
          <MapPinIcon className={styles.cardIcon} />
          <span>{bucket.object_name}</span>
        </div>
        <div className={styles.cardCount}>
          <span className={styles.cardCountValue}>{bucket.online_count}</span>
          <span className={styles.cardCountLabel}>в моменте</span>
        </div>
      </div>
      {bucket.companies.length === 0 ? (
        <div className={styles.cardEmpty}>Сейчас никого нет</div>
      ) : (
        <div className={styles.cardBody}>
          {visibleCompanies.map(company => (
            <div key={company.company_id} className={styles.companyStatic}>
              <span className={styles.companyName}>
                <BuildingIcon className={styles.companyIcon} />
                {company.company_name}
              </span>
              <span className={styles.companyCount}>
                {company.online_count}
                <span className={styles.companyCountLabel}>чел.</span>
              </span>
            </div>
          ))}
          {restCompanies.length > 0 && (
            <div className={styles.companyStaticMore}>
              Прочие — {restCompanies.length} {pluralCompanies(restCompanies.length)}, {restEmployees} чел.
            </div>
          )}
        </div>
      )}
    </article>
  );
};

const CompanyFilter: FC<{
  allCompanies: { id: string; name: string }[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onClear: () => void;
}> = ({ allCompanies, selected, onToggle, onClear }) => {
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

  // Сброс поиска при закрытии — чтобы в следующий раз был чистый список.
  useEffect(() => {
    if (!open) setSearch('');
  }, [open]);

  const selectedList = useMemo(
    () => allCompanies.filter(c => selected.has(c.id)),
    [allCompanies, selected],
  );

  const visibleCompanies = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return allCompanies;
    return allCompanies.filter(c => c.name.toLowerCase().includes(q));
  }, [allCompanies, search]);

  return (
    <div className={styles.companyFilter} ref={wrapperRef}>
      <button
        type="button"
        className={`${styles.companyFilterToggle} ${open ? styles.companyFilterToggleOpen : ''}`}
        onClick={() => setOpen(prev => !prev)}
      >
        Фильтр по компаниям
        {selected.size > 0 && <span className={styles.companyFilterBadge}>{selected.size}</span>}
        <span className={styles.companyFilterCaret} aria-hidden>▾</span>
      </button>

      {selectedList.map(company => {
        const isSynced = isSyncedCompanyId(company.id);
        return (
          <button
            key={company.id}
            type="button"
            className={`${styles.chip} ${styles.chipActive} ${isSynced ? styles.chipSynced : ''}`}
            onClick={() => onToggle(company.id)}
            title="Убрать из фильтра"
          >
            {company.name}
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
              placeholder="Поиск компании"
              value={search}
              onChange={e => setSearch(e.target.value)}
              autoFocus
            />
          </div>
          {visibleCompanies.length === 0 ? (
            <div className={styles.companyFilterEmpty}>
              {allCompanies.length === 0 ? 'Компании не найдены' : 'Ничего не найдено'}
            </div>
          ) : (
            visibleCompanies.map(company => {
              const isActive = selected.has(company.id);
              const isSynced = isSyncedCompanyId(company.id);
              return (
                <label key={company.id} className={styles.companyFilterRow}>
                  <input
                    type="checkbox"
                    checked={isActive}
                    onChange={() => onToggle(company.id)}
                  />
                  <span
                    className={isSynced ? styles.companyFilterRowSynced : undefined}
                    title={isSynced ? 'Синхронизирована с ФОТ' : 'Только в Sigur'}
                  >
                    {company.name}
                  </span>
                </label>
              );
            })
          )}
        </div>
      )}
    </div>
  );
};

export const SkudPresencePage: FC = () => {
  const { data, isLoading, isError, refetch, isFetching } = usePresenceByObjectQuery();
  const [search, setSearch] = useState('');
  const [selectedCompanies, setSelectedCompanies] = useState<Set<string>>(new Set());
  const [hideEmpty, setHideEmpty] = useState(false);
  const [detailsBucket, setDetailsBucket] = useState<IFilteredBucket | null>(null);

  const allCompanies = useMemo(() => {
    if (!data) return [];
    const map = new Map<string, { id: string; name: string }>();
    for (const bucket of data.buckets) {
      for (const company of bucket.companies) {
        if (!map.has(company.company_id)) {
          map.set(company.company_id, { id: company.company_id, name: company.company_name });
        }
      }
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  }, [data]);

  const filtered = useMemo(
    () => filterData(data, search.trim(), selectedCompanies, hideEmpty),
    [data, search, selectedCompanies, hideEmpty],
  );

  const toggleCompanyFilter = (id: string) => {
    setSelectedCompanies(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const isFiltering = search.trim() !== '' || selectedCompanies.size > 0;
  const displayedTotal = isFiltering ? filtered.filteredCount : filtered.totalOnline;

  // Detail-view: ровно 1 приписанный объект (бэк отдаст ровно 1 bucket).
  // При is_unrestricted рендерим обычную сетку даже если backend случайно
  // вернул 1 bucket (например, осталась всего одна стройка в системе).
  const isSingleObjectView = !!data
    && !data.is_unrestricted
    && data.assigned_object_ids.length === 1;

  return (
    <div className={styles.page}>
      <div className={styles.toolbar}>
        <div className={styles.summary}>
          <UsersIcon className={styles.summaryIcon} />
          <div>
            <div className={styles.summaryValue}>{displayedTotal}</div>
            <div className={styles.summaryLabel}>
              {isFiltering ? `найдено из ${filtered.totalOnline}` : 'сейчас на объектах'}
            </div>
          </div>
        </div>

        <div className={styles.searchBox}>
          <SearchIcon className={styles.searchIcon} />
          <input
            className={styles.searchInput}
            type="search"
            placeholder="Поиск по ФИО или должности"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>

        <label className={styles.hideEmpty}>
          <input
            type="checkbox"
            checked={hideEmpty}
            onChange={e => setHideEmpty(e.target.checked)}
          />
          Скрыть пустые объекты
        </label>

        <button
          type="button"
          className={styles.refreshBtn}
          onClick={() => refetch()}
          disabled={isFetching}
          title="Обновить"
        >
          {isFetching ? 'Обновление…' : 'Обновить'}
        </button>
      </div>

      {allCompanies.length > 0 && (
        <CompanyFilter
          allCompanies={allCompanies}
          selected={selectedCompanies}
          onToggle={toggleCompanyFilter}
          onClear={() => setSelectedCompanies(new Set())}
        />
      )}

      {isLoading && <div className={styles.state}>Загрузка…</div>}
      {isError && (
        <div className={`${styles.state} ${styles.stateError}`}>
          Не удалось загрузить данные. Попробуйте обновить страницу.
        </div>
      )}

      {!isLoading && !isError && filtered.buckets.length === 0 && (
        <div className={styles.state}>
          {data && !data.is_unrestricted && data.assigned_object_ids.length === 0
            ? 'У вас нет привязанных объектов. Обратитесь к администратору.'
            : (data?.total_online ?? 0) === 0
              ? 'Сейчас на объектах никого нет'
              : 'Под выбранные фильтры никто не подходит'}
        </div>
      )}

      {isSingleObjectView && filtered.buckets[0] ? (
        <ObjectDetailView bucket={filtered.buckets[0]} className={styles.singleObjectView} />
      ) : (
        <div className={styles.grid}>
          {filtered.buckets.map(bucket => (
            <ObjectCard
              key={bucket.object_id ?? '__no_object__'}
              bucket={bucket}
              onOpenDetails={setDetailsBucket}
            />
          ))}
        </div>
      )}

      {detailsBucket && (
        <ObjectDetailsModal
          bucket={detailsBucket}
          onClose={() => setDetailsBucket(null)}
        />
      )}
    </div>
  );
};
