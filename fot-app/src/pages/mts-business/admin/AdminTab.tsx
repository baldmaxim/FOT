import { type FC, type ReactNode } from 'react';
import { useMtsBusinessAccounts } from '../../../hooks/useMtsBusinessData';
import { useMtsBusinessActions } from '../../../hooks/useMtsBusinessActionsData';
import { useMtsBusinessPdRequests } from '../../../hooks/useMtsBusinessPersonalData';
import { AccountsSection } from './AccountsSection';
import { SyncSection } from './SyncSection';
import { UploadSection } from './UploadSection';
import { ActionsSection } from './ActionsSection';
import { PersonalDataRequestsCard } from '../personal-data/PersonalDataRequestsCard';
import styles from '../MtsBusinessPage.module.css';

const AdminCard: FC<{ id: string; title: string; desc: string; badge?: ReactNode; children: ReactNode }> = ({
  id, title, desc, badge, children,
}) => (
  <section id={id} className={styles.card}>
    <div className={styles.cardHeader}>
      <h2 className={styles.cardHeaderTitle}>{title}</h2>
      {badge != null && <span className={styles.cardHeaderRight}>{badge}</span>}
    </div>
    <p className={styles.cardDesc}>{desc}</p>
    {children}
  </section>
);

/**
 * Вкладка «Администрирование»: карточки-секции с единой шапкой (заголовок +
 * статус) и лентой якорей для быстрого перехода (важно на мобиле).
 */
export const AdminTab: FC = () => {
  const accounts = useMtsBusinessAccounts();
  const actions = useMtsBusinessActions(true);
  const pdRequests = useMtsBusinessPdRequests(true);

  const activeAccounts = (accounts.data ?? []).filter(a => a.isActive).length;
  const actionsInProgress = (actions.data ?? []).filter(a => a.status === 'in_progress').length;
  const pdInProgress = (pdRequests.data ?? []).filter(r => r.status === 'in_progress' || r.status === 'unknown').length;

  const sections = [
    { id: 'mts-admin-accounts', title: 'Аккаунты API' },
    { id: 'mts-admin-sync', title: 'Синхронизация' },
    { id: 'mts-admin-import', title: 'Импорт файлов' },
    { id: 'mts-admin-pd', title: 'Персданные' },
    { id: 'mts-admin-actions', title: 'Действия с номерами' },
  ];

  const scrollTo = (id: string): void => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className={styles.adminStack}>
      <div className={styles.anchors}>
        {sections.map(sct => (
          <button key={sct.id} className={styles.anchorChip} onClick={() => scrollTo(sct.id)}>{sct.title}</button>
        ))}
      </div>

      <AdminCard
        id="mts-admin-accounts"
        title="Аккаунты API"
        desc="Лицевые счета и доступы к МТС Бизнес API. Проверка соединения — живой обмен токена."
        badge={<span className={`${styles.badge} ${activeAccounts > 0 ? styles.badgeOk : styles.badgeMuted}`}>{activeAccounts} активных</span>}
      >
        <AccountsSection />
      </AdminCard>

      <AdminCard
        id="mts-admin-sync"
        title="Синхронизация"
        desc="Фоновые планировщики, точечное обновление финансов/каталога и ручная загрузка детализации за период."
      >
        <SyncSection />
      </AdminCard>

      <AdminCard
        id="mts-admin-import"
        title="Импорт файлов"
        desc="Загрузка XLS/XML-детализации из МТС; из XML извлекаются ФИО владельцев номеров."
      >
        <UploadSection />
      </AdminCard>

      <AdminCard
        id="mts-admin-pd"
        title="Персональные данные — журнал заявок"
        desc="Внесение/изменение/удаление персданных пользователей номеров. Данные уходят в МТС транзитом и на портале не хранятся."
        badge={pdInProgress > 0 ? <span className={`${styles.badge} ${styles.badgeWait}`}>{pdInProgress} в обработке</span> : undefined}
      >
        <PersonalDataRequestsCard />
      </AdminCard>

      <AdminCard
        id="mts-admin-actions"
        title="Действия с номерами"
        desc="Услуги, добровольные блокировки и правила корпоративного бюджета (асинхронные заявки)."
        badge={actionsInProgress > 0 ? <span className={`${styles.badge} ${styles.badgeWait}`}>{actionsInProgress} в обработке</span> : undefined}
      >
        <ActionsSection />
      </AdminCard>
    </div>
  );
};
