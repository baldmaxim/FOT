import { type FC, type ReactNode } from 'react';
import { useMtsBusinessAccounts } from '../../../hooks/useMtsBusinessData';
import { AccountsSection } from './AccountsSection';
import { SyncSection } from './SyncSection';
import { XmlSection } from './XmlSection';
import styles from '../MtsBusinessPage.module.css';

const AdminCard: FC<{ title: string; desc: string; badge?: ReactNode; children: ReactNode }> = ({
  title, desc, badge, children,
}) => (
  <section className={styles.card}>
    <div className={styles.cardHeader}>
      <h2 className={styles.cardHeaderTitle}>{title}</h2>
      {badge != null && <span className={styles.cardHeaderRight}>{badge}</span>}
    </div>
    <p className={styles.cardDesc}>{desc}</p>
    {children}
  </section>
);

/**
 * Вкладка «Администрирование»: аккаунты API, синхронизация и XML-детализация
 * (заказ на почту + загрузка файла). Все действия с номерами (услуги/
 * блокировки/тарифы/персданные/привязки) — в боковой панели абонента
 * (вкладка «Абоненты»).
 */
export const AdminTab: FC = () => {
  const accounts = useMtsBusinessAccounts();
  const activeAccounts = (accounts.data ?? []).filter(a => a.isActive).length;

  return (
    <div className={styles.adminGrid}>
      <AdminCard
        title="Аккаунты API"
        desc="Лицевые счета и доступы к МТС Бизнес API. «Проверить» — живой обмен токена."
        badge={<span className={`${styles.badge} ${activeAccounts > 0 ? styles.badgeOk : styles.badgeErr}`}>{activeAccounts} активных</span>}
      >
        <AccountsSection />
      </AdminCard>

      <AdminCard
        title="Синхронизация"
        desc="Фоновые планировщики, ежедневное автообновление и точечное обновление финансов/каталога."
      >
        <SyncSection />
      </AdminCard>

      <AdminCard
        title="Детализация XML (email)"
        desc="Заказ XML-детализации на почту по счёту, статусы заявок и загрузка файла (до 300 МБ) с дедупликацией против БД."
      >
        <XmlSection />
      </AdminCard>
    </div>
  );
};
