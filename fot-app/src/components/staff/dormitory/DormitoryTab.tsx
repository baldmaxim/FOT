import { useId, useMemo, useState, type FC } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { useAuth } from '../../../contexts/AuthContext';
import {
  DORMITORY_ADDRESSES_KEY,
  DORMITORY_APARTMENTS_KEY,
  DORMITORY_STAYS_KEY,
  dormitoryService,
} from '../../../services/dormitoryService';
import { PAYROLL_TERMS_PREFIX } from '../../../services/payrollRegistryService';
import { DORMITORY_PRESET_ADDRESSES, dormitoryAddressOptions } from '../../../utils/dormitoryStayForm';
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

/** «Кв. …» — адрес служебной квартиры, общежитию его не подсказываем (миграция 371). */
const isFlatAddress = (address: string): boolean => /^\s*кв[.\s]/i.test(address);

/**
 * «Управление кадрами» → «Проживание» (миграции 314, 320, 371): вкладки «Квартира» (служебные квартиры компании, как
 * «Учёт квартир» 1С), «Общежитие» (как отчёт «Проживающие в общежитии последний вход (СКД)») и «Компенсация аренды»
 * (630 ₽/день — те же записи, что «Доплата → Квартира» «Зарплаты»). Вкладка загружается при первом открытии и дальше
 * остаётся смонтированной (поиск и фильтры целы); таблица прокручивается внутри — шапка закреплена.
 */
export const DormitoryTab: FC = () => {
  const { isAdmin, canEditPage } = useAuth();
  const canEdit = isAdmin || canEditPage('/staff-control/dormitory');
  const queryClient = useQueryClient();
  const baseId = useId();
  const [tab, setTab] = useState<HousingTab>('apartment');
  const [visited, setVisited] = useState<ReadonlySet<HousingTab>>(() => new Set(['apartment']));

  const changeTab = (next: HousingTab) => {
    setTab(next);
    setVisited(prev => (prev.has(next) ? prev : new Set([...prev, next])));
  };

  // Подсказки общежитий: 9 общежитий компании и сохранённые адреса — нужны только окнам правки.
  const addressesQuery = useQuery({
    queryKey: DORMITORY_ADDRESSES_KEY,
    queryFn: ({ signal }) => dormitoryService.listAddresses(signal),
    enabled: canEdit,
    staleTime: 0,
  });
  const addresses = useMemo(
    () => dormitoryAddressOptions([...DORMITORY_PRESET_ADDRESSES, ...(addressesQuery.data ?? [])])
      .filter(address => !isFlatAddress(address)),
    [addressesQuery.data],
  );
  // Квартиры для «Переселить» из общежития — те же данные, что вкладка «Квартира» (общий ключ, один запрос).
  const apartmentsQuery = useQuery({
    queryKey: DORMITORY_APARTMENTS_KEY,
    queryFn: ({ signal }) => dormitoryService.listApartments(signal),
    enabled: canEdit && visited.has('dormitory'),
    staleTime: 0,
  });

  // Общий префикс: квартиры, жильцы, компенсация, подсказки и «Справочник» «Зарплаты»; квартиры-компенсации — ещё и
  // «Доплата за проживание» условий оплаты (префикс 'payroll-terms').
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: DORMITORY_STAYS_KEY });
    void queryClient.invalidateQueries({ queryKey: PAYROLL_TERMS_PREFIX });
  };

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
      <RegistryTabs
        tabs={HOUSING_TABS}
        active={tab}
        onChange={changeTab}
        tabId={tabId}
        panelId={panelId}
        label="Разделы проживания"
      />

      <div {...panelProps('apartment')}>
        {visited.has('apartment') && <ApartmentsPanel canEdit={canEdit} addresses={addresses} onChanged={refresh} />}
      </div>
      <div {...panelProps('dormitory')}>
        {visited.has('dormitory') && (
          <DormitoryResidentsPanel
            canEdit={canEdit}
            addresses={addresses}
            apartments={apartmentsQuery.data?.apartments ?? []}
            onChanged={refresh}
          />
        )}
      </div>
      <div {...panelProps('compensation')}>
        {visited.has('compensation') && <CompensationPanel canEdit={canEdit} onChanged={refresh} />}
      </div>
    </div>
  );
};
