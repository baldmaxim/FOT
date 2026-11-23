import { useId, useMemo, useState, type FC } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';

import { useAuth } from '../../../contexts/AuthContext';
import {
  DORMITORY_ADDRESSES_KEY,
  DORMITORY_STAYS_KEY,
  dormitoryService,
} from '../../../services/dormitoryService';
import { PAYROLL_TERMS_PREFIX } from '../../../services/payrollRegistryService';
import { dormitoryAddressOptions } from '../../../utils/dormitoryStayForm';
import { housingMonthOptions } from '../../../utils/housingTables';
import { moscowTodayIso } from '../../../utils/moscowDate';
import { MonthSelect } from '../../ui/MonthSelect';
import { RegistryTabs, type IRegistryTab } from '../../ui/registry/RegistryTabs';
import tabStyles from '../../ui/registry/RegistryTabs.module.css';
import { ApartmentsPanel } from './ApartmentsPanel';
import { CompensationPanel } from './CompensationPanel';
import { DormitoryResidentsPanel } from './DormitoryResidentsPanel';
import styles from './DormitoryTab.module.css';

type HousingTab = 'apartment' | 'dormitory' | 'compensation';

const HOUSING_TABS: ReadonlyArray<IRegistryTab<HousingTab>> = [
  { key: 'apartment', label: 'Квартира' },
  { key: 'dormitory', label: 'Общежитие' },
  { key: 'compensation', label: 'Компенсация аренды' },
];

const isHousingTab = (value: string | null): value is HousingTab => HOUSING_TABS.some(item => item.key === value);

/** «Кв. …» — адрес служебной квартиры, общежитию его не подсказываем (миграция 371). */
const isFlatAddress = (address: string): boolean => /^\s*кв[.\s]/i.test(address);

/**
 * «Управление кадрами» → «Проживание» (миграции 314, 320, 371, 374): вкладки «Квартира» (служебные квартиры компании,
 * как «Учёт квартир» 1С), «Общежитие» (как отчёт «Проживающие в общежитии последний вход (СКД)») и «Компенсация
 * аренды» (630 ₽/день — те же записи, что «Доплата → Квартира» «Зарплаты»). Один выбор месяца на все вкладки — справа
 * от вкладок (на телефоне — строкой ниже); вкладка и месяц читаются из адреса при открытии (?housing=…&month=… —
 * возврат из карточки сотрудника). Вкладка загружается при первом открытии и дальше остаётся смонтированной (поиск и
 * фильтры целы); таблица прокручивается внутри — шапка закреплена.
 */
export const DormitoryTab: FC = () => {
  const { isAdmin, canEditPage } = useAuth();
  const canEdit = isAdmin || canEditPage('/staff-control/dormitory');
  const queryClient = useQueryClient();
  const baseId = useId();
  const [searchParams] = useSearchParams();
  const currentMonth = moscowTodayIso().slice(0, 7);
  const monthOptions = useMemo(() => housingMonthOptions(currentMonth), [currentMonth]);
  const [tab, setTab] = useState<HousingTab>(() => {
    const requested = searchParams.get('housing');
    return isHousingTab(requested) ? requested : 'apartment';
  });
  const [month, setMonth] = useState(() => {
    const requested = searchParams.get('month');
    return requested && monthOptions.includes(requested) ? requested : currentMonth;
  });
  const [visited, setVisited] = useState<ReadonlySet<HousingTab>>(() => new Set([tab]));

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
  const cardBackPath = (key: HousingTab) => `/staff-control?tab=dormitory&housing=${key}&month=${month}`;

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
            cardBackPath={cardBackPath('apartment')}
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
