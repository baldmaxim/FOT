/**
 * Страница «Пропуск подрядчика» (URL остался /admin/contractor-approvals для
 * обратной совместимости). 4 вкладки:
 *  - «Общий пул» — настройка папки Sigur, добавление карт в пул, назначение
 *    подрядчику. Внутри есть переключатель на «прямой режим» (минуя пул).
 *  - «Отправленные» — пропуска, переданные подрядчику и ещё не одобренные.
 *  - «Заявки» — заявки на согласовании с поштучным/массовым решением.
 *  - «Мониторинг» — все пропуска выбранного подрядчика со статусом
 *    «активен / не активен» + история ФИО и решений.
 */
import { useState, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PoolTab } from '../../components/contractor/PoolTab';
import { SentTab } from '../../components/contractor/SentTab';
import { SubmissionsTab } from '../../components/contractor/SubmissionsTab';
import { MonitorTab } from '../../components/contractor/MonitorTab';
import { RemovalRequestsTab } from '../../components/contractor/RemovalRequestsTab';
import { OtitbTab } from '../../components/contractor/OtitbTab';
import { usePendingContractorRemovalsCount } from '../../hooks/usePendingContractorRemovalsCount';
import { useContractorSyncFailedCount } from '../../hooks/useContractorSyncFailedCount';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { contractorAdminService } from '../../services/contractorService';
import { useAuth } from '../../contexts/AuthContext';
import styles from '../contractor/Contractor.module.css';

type Tab = 'pool' | 'sent' | 'submissions' | 'monitor' | 'removals' | 'otitb';

export const ContractorApprovalsPage: FC = () => {
  const { isAdmin, canViewPage } = useAuth();
  const hasFullSection = isAdmin || canViewPage('/admin/contractor-approvals');
  // Узкая роль ОТиТБ: только технические ключи вкладок, полного ключа раздела нет.
  // Показываем ей лишь доступные вкладки (ОТиТБ и/или «Заявки на согласование»).
  const canOtitb = hasFullSection || canViewPage('/admin/contractor-approvals/otitb');
  const canSubmissions = hasFullSection || canViewPage('/admin/contractor-approvals/submissions');
  const narrowRole = !hasFullSection;
  // Начальная вкладка: для полного доступа — пул, для узкой роли — первая доступная.
  const initialTab: Tab = hasFullSection ? 'pool' : (canOtitb ? 'otitb' : 'submissions');
  const [tab, setTab] = useState<Tab>(initialTab);
  // Поиск по ФИО во вкладке «Заявки на согласование» (состояние поднято на страницу,
  // поле живёт в строке вкладок). Сбрасывается при реальной смене вкладки.
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search.trim(), 300);
  const changeTab = (t: Tab) => {
    if (t !== tab) setSearch('');
    setTab(t);
  };

  const pendingSubsQuery = useQuery({
    queryKey: ['contractor-pending-subs', ''],
    queryFn: () => contractorAdminService.getPendingSubmissions(),
    staleTime: 15_000,
    refetchInterval: 10_000,
  });
  const pendingCount = pendingSubsQuery.data?.length ?? 0;
  const removalsCount = usePendingContractorRemovalsCount();
  const syncFailedCount = useContractorSyncFailedCount();

  return (
    <div className={styles.page}>
      <div className={styles.tabs}>
        {!narrowRole && (
          <>
            <button
              className={`${styles.tab} ${tab === 'pool' ? styles.tabActive : ''}`}
              onClick={() => changeTab('pool')}
            >
              Общий пул
            </button>
            <button
              className={`${styles.tab} ${tab === 'sent' ? styles.tabActive : ''}`}
              onClick={() => changeTab('sent')}
            >
              Отправленные
            </button>
          </>
        )}
        {canOtitb && (
          <button
            className={`${styles.tab} ${tab === 'otitb' ? styles.tabActive : ''}`}
            onClick={() => changeTab('otitb')}
          >
            ОТиТБ
          </button>
        )}
        {canSubmissions && (
          <button
            className={`${styles.tab} ${tab === 'submissions' ? styles.tabActive : ''}`}
            onClick={() => changeTab('submissions')}
          >
            Заявки на согласование
            {pendingCount > 0 && <span className={styles.tabBadge}>{pendingCount}</span>}
          </button>
        )}
        {!narrowRole && (
          <>
            <button
              className={`${styles.tab} ${tab === 'monitor' ? styles.tabActive : ''}`}
              onClick={() => changeTab('monitor')}
            >
              Мониторинг
              {syncFailedCount > 0 && <span className={styles.tabBadge}>{syncFailedCount}</span>}
            </button>
            <button
              className={`${styles.tab} ${tab === 'removals' ? styles.tabActive : ''}`}
              onClick={() => changeTab('removals')}
            >
              Заявки на удаление сотрудников
              {removalsCount > 0 && <span className={styles.tabBadge}>{removalsCount}</span>}
            </button>
          </>
        )}
        {tab === 'submissions' && (
          <input
            className={`${styles.input} ${styles.tabsSearch}`}
            type="search"
            inputMode="search"
            placeholder="Поиск по ФИО"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        )}
      </div>

      {tab === 'pool' && !narrowRole && <PoolTab />}
      {tab === 'sent' && !narrowRole && <SentTab />}
      {tab === 'otitb' && canOtitb && <OtitbTab />}
      {tab === 'submissions' && canSubmissions && <SubmissionsTab search={debouncedSearch} />}
      {tab === 'monitor' && !narrowRole && <MonitorTab />}
      {tab === 'removals' && !narrowRole && <RemovalRequestsTab />}
    </div>
  );
};

export default ContractorApprovalsPage;
