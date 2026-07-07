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
import { usePendingContractorRemovalsCount } from '../../hooks/usePendingContractorRemovalsCount';
import { useContractorSyncFailedCount } from '../../hooks/useContractorSyncFailedCount';
import { contractorAdminService } from '../../services/contractorService';
import { useAuth } from '../../contexts/AuthContext';
import styles from '../contractor/Contractor.module.css';

type Tab = 'pool' | 'sent' | 'submissions' | 'monitor' | 'removals';

export const ContractorApprovalsPage: FC = () => {
  const { isAdmin, canViewPage } = useAuth();
  // Узкая роль ОТиТБ: есть только технический ключ вкладки «Заявки на согласование»,
  // полного ключа раздела нет → показываем ей единственную вкладку.
  const submissionsOnly = !isAdmin
    && !canViewPage('/admin/contractor-approvals')
    && canViewPage('/admin/contractor-approvals/submissions');
  const [tab, setTab] = useState<Tab>(submissionsOnly ? 'submissions' : 'pool');

  const pendingSubsQuery = useQuery({
    queryKey: ['contractor-pending-subs'],
    queryFn: contractorAdminService.getPendingSubmissions,
    staleTime: 15_000,
    refetchInterval: 10_000,
  });
  const pendingCount = pendingSubsQuery.data?.length ?? 0;
  const removalsCount = usePendingContractorRemovalsCount();
  const syncFailedCount = useContractorSyncFailedCount();

  return (
    <div className={styles.page}>
      <div className={styles.tabs}>
        {!submissionsOnly && (
          <>
            <button
              className={`${styles.tab} ${tab === 'pool' ? styles.tabActive : ''}`}
              onClick={() => setTab('pool')}
            >
              Общий пул
            </button>
            <button
              className={`${styles.tab} ${tab === 'sent' ? styles.tabActive : ''}`}
              onClick={() => setTab('sent')}
            >
              Отправленные
            </button>
          </>
        )}
        <button
          className={`${styles.tab} ${tab === 'submissions' ? styles.tabActive : ''}`}
          onClick={() => setTab('submissions')}
        >
          Заявки на согласование
          {pendingCount > 0 && <span className={styles.tabBadge}>{pendingCount}</span>}
        </button>
        {!submissionsOnly && (
          <>
            <button
              className={`${styles.tab} ${tab === 'monitor' ? styles.tabActive : ''}`}
              onClick={() => setTab('monitor')}
            >
              Мониторинг
              {syncFailedCount > 0 && <span className={styles.tabBadge}>{syncFailedCount}</span>}
            </button>
            <button
              className={`${styles.tab} ${tab === 'removals' ? styles.tabActive : ''}`}
              onClick={() => setTab('removals')}
            >
              Заявки на удаление сотрудников
              {removalsCount > 0 && <span className={styles.tabBadge}>{removalsCount}</span>}
            </button>
          </>
        )}
      </div>

      {tab === 'pool' && !submissionsOnly && <PoolTab />}
      {tab === 'sent' && !submissionsOnly && <SentTab />}
      {tab === 'submissions' && <SubmissionsTab />}
      {tab === 'monitor' && !submissionsOnly && <MonitorTab />}
      {tab === 'removals' && !submissionsOnly && <RemovalRequestsTab />}
    </div>
  );
};

export default ContractorApprovalsPage;
