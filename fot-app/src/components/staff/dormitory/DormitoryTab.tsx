import { useEffect, useId, useMemo, useRef, useState, type FC } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';

import { useAuth } from '../../../contexts/AuthContext';
import { useSessionState } from '../../../hooks/useSessionState';
import {
  DORMITORY_ADDRESSES_KEY,
  DORMITORY_STAYS_KEY,
  dormitoryService,
} from '../../../services/dormitoryService';
import { PAYROLL_TERMS_PREFIX } from '../../../services/payrollRegistryService';
import { dormitoryAddressOptions } from '../../../utils/dormitoryStayForm';
import {
  housingBackPath,
  housingMonthOptions,
  readHousingReturn,
  stripHousingReturn,
  type HousingTab,
} from '../../../utils/housingTables';
import { moscowTodayIso } from '../../../utils/moscowDate';
import { MonthSelect } from '../../ui/MonthSelect';
import { RegistryTabs, type IRegistryTab } from '../../ui/registry/RegistryTabs';
import tabStyles from '../../ui/registry/RegistryTabs.module.css';
import { ApartmentsPanel } from './ApartmentsPanel';
import { CompensationPanel } from './CompensationPanel';
import { DormitoryResidentsPanel } from './DormitoryResidentsPanel';
import styles from './DormitoryTab.module.css';

const HOUSING_TABS: ReadonlyArray<IRegistryTab<HousingTab>> = [
  { key: 'apartment', label: 'Квартира' },
  { key: 'dormitory', label: 'Общежитие' },
  { key: 'compensation', label: 'Компенсация аренды' },
];

const isHousingTab = (value: unknown): value is HousingTab => HOUSING_TABS.some(item => item.key === value);
const parseHousingTab = (raw: unknown): HousingTab | null => (isHousingTab(raw) ? raw : null);

/** «Кв. …» — адрес служебной квартиры, общежитию его не подсказываем (миграция 371). */
const isFlatAddress = (address: string): boolean => /^\s*кв[.\s]/i.test(address);

/**
 * «Управление кадрами» → «Проживание» (миграции 314, 320, 371, 374): вкладки «Квартира» (служебные квартиры компании,
 * как «Учёт квартир» 1С), «Общежитие» (как отчёт «Проживающие в общежитии последний вход (СКД)») и «Компенсация
 * аренды» (630 ₽/день — те же записи, что «Доплата → Квартира» «Зарплаты»). Один выбор месяца на все вкладки — справа
 * от вкладок (на телефоне — строкой ниже). Вкладка и месяц живут в sessionStorage (useSessionState): переживают уход в
 * карточку сотрудника и смену вкладок раздела. Адрес возврата из карточки (?tab=dormitory&housing=…&month=…&apartment=…)
 * важнее сохранённого, читается один раз и убирается — старый месяц из адреса не перебьёт выбранный позже. Вкладка
 * загружается при первом открытии и дальше остаётся смонтированной; таблица прокручивается внутри — шапка закреплена.
 */
export const DormitoryTab: FC = () => {
  const { isAdmin, canEditPage } = useAuth();
  const canEdit = isAdmin || canEditPage('/staff-control/dormitory');
  const queryClient = useQueryClient();
  const baseId = useId();
  const [searchParams, setSearchParams] = useSearchParams();
  const currentMonth = moscowTodayIso().slice(0, 7);
  const monthOptions = useMemo(() => housingMonthOptions(currentMonth), [currentMonth]);
  // Возврат из карточки: адрес — один раз, при открытии раздела.
  const [returned] = useState(() => readHousingReturn(searchParams));
  const isMonthOption = (value: unknown): value is string => typeof value === 'string' && monthOptions.includes(value);
  const [tab, setTab] = useSessionState<HousingTab>('housing.tab', 'apartment', {
    parse: parseHousingTab,
    override: parseHousingTab(returned.housing),
  });
  const [month, setMonth] = useSessionState<string>('housing.month', currentMonth, {
    parse: raw => (isMonthOption(raw) ? raw : null),
    override: isMonthOption(returned.month) ? returned.month : null,
  });
  const [visited, setVisited] = useState<ReadonlySet<HousingTab>>(() => new Set([tab]));

  // Параметры возврата прочитаны — убрать из адреса (replace): окно квартиры не откроется само при следующем заходе.
  const stripped = useRef(false);
  useEffect(() => {
    if (stripped.current) return;
    stripped.current = true;
    const next = stripHousingReturn(searchParams);
    if (next) setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const changeTab = (next: HousingTab) => {
    setTab(next);
    setVisited(prev => (prev.has(next) ? prev : new Set([...prev, next])));
  };

  // Общежития справочника (миграция 377) — выбор общежития в окнах заселения, правки и переселения.
  const addressesQuery = useQuery({
    queryKey: DORMITORY_ADDRESSES_KEY,
    queryFn: ({ signal }) => dormitoryService.listAddresses(signal),
    enabled: canEdit,
    staleTime: 0,
  });
  const addresses = useMemo(
    () => dormitoryAddressOptions(addressesQuery.data ?? []).filter(address => !isFlatAddress(address)),
    [addressesQuery.data],
  );

  // Общий префикс: квартиры, жильцы, компенсация, подсказки и «Справочник» «Зарплаты»; квартиры-компенсации — ещё и
  // «Доплата за проживание» условий оплаты (префикс 'payroll-terms').
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: DORMITORY_STAYS_KEY });
    void queryClient.invalidateQueries({ queryKey: PAYROLL_TERMS_PREFIX });
  };

  /** Адрес возврата из карточки сотрудника: эта вкладка и месяц. */
  const cardBackPath = (key: HousingTab) => housingBackPath(key, month);

  const tabId = (key: HousingTab) => `${baseId}-tab-${key}`;
  const panelId = (key: HousingTab) => `${baseId}-panel-${key}`;
  const panelProps = (key: HousingTab) => ({
    className: tabStyles.tabPanel,
    role: 'tabpanel',
    id: panelId(key),
    'aria-labelledby': tabId(key),
    hidden: tab !== key,
    // Таблица прокручивается внутри панели, шапка закреплена (RegistryTable.module.css).
    'data-registry-fill': true,
  });

  return (
    <div className={styles.root}>
      <div className={styles.tabsRow}>
        <RegistryTabs
          tabs={HOUSING_TABS}
          active={tab}
          onChange={changeTab}
          tabId={tabId}
          panelId={panelId}
          label="Разделы проживания"
          className={styles.tabsInRow}
        />
        <MonthSelect value={month} options={monthOptions} onChange={setMonth} className={styles.monthSelect} />
      </div>

      <div {...panelProps('apartment')}>
        {visited.has('apartment') && (
          <ApartmentsPanel
            canEdit={canEdit}
            addresses={addresses}
            month={month}
            initialOpenedId={returned.apartment}
            onChanged={refresh}
          />
        )}
      </div>
      <div {...panelProps('dormitory')}>
        {visited.has('dormitory') && (
          <DormitoryResidentsPanel
            canEdit={canEdit}
            addresses={addresses}
            month={month}
            cardBackPath={cardBackPath('dormitory')}
            onChanged={refresh}
          />
        )}
      </div>
      <div {...panelProps('compensation')}>
        {visited.has('compensation') && (
          <CompensationPanel
            canEdit={canEdit}
            month={month}
            cardBackPath={cardBackPath('compensation')}
            onChanged={refresh}
          />
        )}
      </div>
    </div>
  );
};
