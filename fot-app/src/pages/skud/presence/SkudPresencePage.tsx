import { useMemo, useState, type FC } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { usePresenceByObjectQuery, presenceByObjectQueryKey } from '../../../hooks/useEmployeeDirectory';
import { usePresenceRealtime } from '../../../hooks/usePresenceRealtime';
import { MapPinIcon, UsersIcon, SearchIcon, BuildingIcon } from '../../../components/ui/Icons';
import type {
  IPresenceByObjectResponse,
  IPresenceObjectBucket,
  IPresenceObjectCompany,
  IPresenceObjectEmployee,
} from '../../../types';
import { ObjectDetailsModal } from './ObjectDetailsModal';
import { ObjectDetailView } from './ObjectDetailView';
import { EntityFilter } from './EntityFilter';
import { PresenceExportModal } from './PresenceExportModal';
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
  selectedObjectIds: Set<string>,
  hideEmpty: boolean,
): {
  buckets: IFilteredBucket[];
  totalOnline: number;
  filteredCount: number;
} => {
  if (!data) return { buckets: [], totalOnline: 0, filteredCount: 0 };
  const q = search.toLowerCase();
  const hasCompanyFilter = selectedCompanyIds.size > 0;
  const hasObjectFilter = selectedObjectIds.size > 0;
  const isActive = q !== '' || hasCompanyFilter || hasObjectFilter;

  const buckets: IFilteredBucket[] = [];
  let filteredCount = 0;

  for (const bucket of data.buckets) {
    const objectKey = bucket.object_id ?? '__no_object__';
    if (hasObjectFilter && !selectedObjectIds.has(objectKey)) continue;

    // Поиск по названию объекта: совпал — показываем весь объект.
    const objectMatches = q !== '' && bucket.object_name.toLowerCase().includes(q);

    const filteredCompanies: IPresenceObjectCompany[] = [];
    let bucketTotal = 0;

    for (const company of bucket.companies) {
      if (hasCompanyFilter && !selectedCompanyIds.has(company.company_id)) continue;
      // Поиск по названию компании: совпал — показываем весь её состав.
      const companyMatches = q !== '' && company.company_name.toLowerCase().includes(q);
      const matched = objectMatches || companyMatches
        ? company.employees
        : company.employees.filter(emp => matchesEmployee(emp, search));
      if (matched.length === 0 && isActive) continue;
      filteredCompanies.push({ ...company, online_count: matched.length, employees: matched });
      bucketTotal += matched.length;
      filteredCount += matched.length;
    }

    // Под активным поиском/фильтром объект без совпадений скрываем целиком.
    if (bucketTotal === 0 && (isActive || hideEmpty)) continue;

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
          <span className={styles.cardCountLabel}>{bucket.is_partial ? 'ваши' : 'в моменте'}</span>
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

export const SkudPresencePage: FC = () => {
  const { data, isLoading, isError, refetch, isFetching } = usePresenceByObjectQuery();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [selectedCompanies, setSelectedCompanies] = useState<Set<string>>(new Set());
  const [selectedObjects, setSelectedObjects] = useState<Set<string>>(new Set());
  const [hideEmpty, setHideEmpty] = useState(false);
  const [detailsBucket, setDetailsBucket] = useState<IFilteredBucket | null>(null);
  const [exportOpen, setExportOpen] = useState(false);

  // Прямой эфир: socket `presence_updated` (как на дашборде) → мгновенный
  // refetch. 30-сек polling в usePresenceByObjectQuery остаётся как fallback.
  usePresenceRealtime({
    owner: 'skud-presence',
    enabled: true,
    onPresenceUpdate: () => {
      void queryClient.invalidateQueries({ queryKey: presenceByObjectQueryKey() });
    },
  });

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

  const allObjects = useMemo(() => {
    if (!data) return [];
    const map = new Map<string, { id: string; name: string }>();
    for (const bucket of data.buckets) {
      const id = bucket.object_id ?? '__no_object__';
      if (!map.has(id)) map.set(id, { id, name: bucket.object_name });
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  }, [data]);

  const filtered = useMemo(
    () => filterData(data, search.trim(), selectedCompanies, selectedObjects, hideEmpty),
    [data, search, selectedCompanies, selectedObjects, hideEmpty],
  );

  const toggleCompanyFilter = (id: string) => {
    setSelectedCompanies(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleObjectFilter = (id: string) => {
    setSelectedObjects(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const isFiltering = search.trim() !== ''
    || selectedCompanies.size > 0
    || selectedObjects.size > 0;
  const displayedTotal = isFiltering ? filtered.filteredCount : filtered.totalOnline;

  // Detail-view: ровно 1 приписанный объект (бэк отдаст ровно 1 bucket).
  // Только для чистого объектного режима: при object_employee (union — назначенный
  // объект + свои сотрудники на других) рисуем сетку, иначе чужие объекты скроются.
  const isSingleObjectView = !!data
    && data.scope_mode === 'object'
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
            placeholder="Поиск по ФИО, компании или объекту"
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

      {/* Строка фильтров рендерится всегда — кнопка выгрузки не зависит от состава данных. */}
      <div className={styles.filters}>
        {allCompanies.length > 0 && (
          <EntityFilter
            label="Фильтр по компаниям"
            searchPlaceholder="Поиск компании"
            emptyText="Компании не найдены"
            allEntities={allCompanies}
            selected={selectedCompanies}
            onToggle={toggleCompanyFilter}
            onClear={() => setSelectedCompanies(new Set())}
            isSynced={isSyncedCompanyId}
          />
        )}
        {allObjects.length > 1 && !isSingleObjectView && (
          <EntityFilter
            label="Фильтр по объектам"
            searchPlaceholder="Поиск объекта"
            emptyText="Объекты не найдены"
            allEntities={allObjects}
            selected={selectedObjects}
            onToggle={toggleObjectFilter}
            onClear={() => setSelectedObjects(new Set())}
          />
        )}
        <button
          type="button"
          className={styles.exportBtn}
          onClick={() => setExportOpen(true)}
        >
          Экспорт в Excel
        </button>
      </div>

      {isLoading && <div className={styles.state}>Загрузка…</div>}
      {isError && (
        <div className={`${styles.state} ${styles.stateError}`}>
          Не удалось загрузить данные. Попробуйте обновить страницу.
        </div>
      )}

      {!isLoading && !isError && filtered.buckets.length === 0 && (
        <div className={styles.state}>
          {data?.scope_mode === 'employee'
            ? 'Сейчас никого из ваших сотрудников на объектах нет'
            : data && !data.is_unrestricted && data.assigned_object_ids.length === 0
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

      {exportOpen && <PresenceExportModal onClose={() => setExportOpen(false)} />}
    </div>
  );
};
