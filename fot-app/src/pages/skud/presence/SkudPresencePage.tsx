import { useMemo, useState, type FC } from 'react';
import { usePresenceByObjectQuery } from '../../../hooks/useEmployeeDirectory';
import { MapPinIcon, UsersIcon, SearchIcon, BuildingIcon } from '../../../components/ui/Icons';
import type {
  IPresenceByObjectResponse,
  IPresenceObjectBucket,
  IPresenceObjectCompany,
  IPresenceObjectEmployee,
} from '../../../types';
import styles from './SkudPresencePage.module.css';

const formatTime = (value: string | null): string => {
  if (!value) return '—';
  return value.slice(0, 5);
};

const matchesEmployee = (emp: IPresenceObjectEmployee, query: string): boolean => {
  if (!query) return true;
  const normalized = query.toLowerCase();
  return emp.full_name.toLowerCase().includes(normalized)
    || (emp.position_name?.toLowerCase().includes(normalized) ?? false);
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

const EmployeeRow: FC<{ emp: IPresenceObjectEmployee }> = ({ emp }) => (
  <li className={styles.employeeRow}>
    <div className={styles.employeeName}>{emp.full_name}</div>
    <div className={styles.employeeMeta}>
      {emp.position_name && <span>{emp.position_name}</span>}
      <span className={styles.employeeTime}>с {formatTime(emp.first_entry)}</span>
      {emp.last_access_point && (
        <span className={styles.employeeAp} title={emp.last_access_point}>
          <MapPinIcon className={styles.tinyIcon} />
          {emp.last_access_point}
        </span>
      )}
    </div>
  </li>
);

const CompanyGroup: FC<{
  company: IPresenceObjectCompany;
  isExpanded: boolean;
  onToggle: () => void;
}> = ({ company, isExpanded, onToggle }) => {
  const isClickable = company.online_count > 0;
  return (
    <div className={styles.company}>
      <button
        type="button"
        className={`${styles.companyHeader} ${isExpanded ? styles.companyHeaderOpen : ''}`}
        onClick={onToggle}
        disabled={!isClickable}
      >
        <span className={styles.companyName}>
          <BuildingIcon className={styles.companyIcon} />
          {company.company_name}
        </span>
        <span className={styles.companyCount}>
          {company.online_count}
          <span className={styles.companyCountLabel}>чел.</span>
        </span>
      </button>
      {isExpanded && company.employees.length > 0 && (
        <ul className={styles.employeeList}>
          {company.employees.map(emp => <EmployeeRow key={emp.employee_id} emp={emp} />)}
        </ul>
      )}
    </div>
  );
};

const ObjectCard: FC<{
  bucket: IFilteredBucket;
  expanded: Set<string>;
  onToggleCompany: (key: string) => void;
}> = ({ bucket, expanded, onToggleCompany }) => (
  <article className={styles.card}>
    <header className={styles.cardHeader}>
      <div className={styles.cardTitle}>
        <MapPinIcon className={styles.cardIcon} />
        <span>{bucket.object_name}</span>
      </div>
      <div className={styles.cardCount}>
        <span className={styles.cardCountValue}>{bucket.online_count}</span>
        <span className={styles.cardCountLabel}>в моменте</span>
      </div>
    </header>
    {bucket.companies.length === 0 ? (
      <div className={styles.cardEmpty}>Сейчас никого нет</div>
    ) : (
      <div className={styles.cardBody}>
        {bucket.companies.map(company => {
          const key = `${bucket.object_id ?? '__no_object__'}::${company.company_id}`;
          return (
            <CompanyGroup
              key={key}
              company={company}
              isExpanded={expanded.has(key)}
              onToggle={() => onToggleCompany(key)}
            />
          );
        })}
      </div>
    )}
  </article>
);

export const SkudPresencePage: FC = () => {
  const { data, isLoading, isError, refetch, isFetching } = usePresenceByObjectQuery();
  const [search, setSearch] = useState('');
  const [selectedCompanies, setSelectedCompanies] = useState<Set<string>>(new Set());
  const [hideEmpty, setHideEmpty] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

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

  const toggleExpanded = (key: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const isFiltering = search.trim() !== '' || selectedCompanies.size > 0;
  const displayedTotal = isFiltering ? filtered.filteredCount : filtered.totalOnline;

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
        <div className={styles.companyFilter}>
          {allCompanies.map(company => {
            const isActive = selectedCompanies.has(company.id);
            return (
              <button
                key={company.id}
                type="button"
                className={`${styles.chip} ${isActive ? styles.chipActive : ''}`}
                onClick={() => toggleCompanyFilter(company.id)}
              >
                {company.name}
              </button>
            );
          })}
          {selectedCompanies.size > 0 && (
            <button
              type="button"
              className={styles.chipClear}
              onClick={() => setSelectedCompanies(new Set())}
            >
              Сбросить
            </button>
          )}
        </div>
      )}

      {isLoading && <div className={styles.state}>Загрузка…</div>}
      {isError && (
        <div className={`${styles.state} ${styles.stateError}`}>
          Не удалось загрузить данные. Попробуйте обновить страницу.
        </div>
      )}

      {!isLoading && !isError && filtered.buckets.length === 0 && (
        <div className={styles.state}>
          {(data?.total_online ?? 0) === 0
            ? 'Сейчас на объектах никого нет'
            : 'Под выбранные фильтры никто не подходит'}
        </div>
      )}

      <div className={styles.grid}>
        {filtered.buckets.map(bucket => (
          <ObjectCard
            key={bucket.object_id ?? '__no_object__'}
            bucket={bucket}
            expanded={expanded}
            onToggleCompany={toggleExpanded}
          />
        ))}
      </div>
    </div>
  );
};
