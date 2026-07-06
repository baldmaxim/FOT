import { type FC } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { OverviewSection } from './OverviewSection';
import { SubscribersTab } from './subscribers/SubscribersTab';
import { AdminTab } from './admin/AdminTab';
import styles from './MtsBusinessPage.module.css';

// Страница «МТС Бизнес», вкладки привязаны к URL:
//   /mts-business             — «Основное» (обзор + кнопка «Обновить»)
//   /mts-business/subscribers — «Абоненты» (таблица + боковая панель управления)
//   /mts-business/admin       — «Администрирование»
// Секции декомпозированы: subscribers/*, admin/*, overview/*, personal-data/*.

type Tab = 'main' | 'subscribers' | 'admin';

const TAB_PATHS: Record<Tab, string> = {
  main: '/mts-business',
  subscribers: '/mts-business/subscribers',
  admin: '/mts-business/admin',
};

const pathToTab = (pathname: string): Tab =>
  pathname.includes('/mts-business/subscribers') ? 'subscribers'
    : pathname.includes('/mts-business/admin') ? 'admin'
    : 'main';

export const MtsBusinessPage: FC = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const tab = pathToTab(location.pathname);
  const go = (t: Tab): void => { if (t !== tab) navigate(TAB_PATHS[t]); };

  return (
    <div className={styles.page}>
      <div className={styles.tabs}>
        <button className={`${styles.tab} ${tab === 'main' ? styles.tabActive : ''}`} onClick={() => go('main')}>Основное</button>
        <button className={`${styles.tab} ${tab === 'subscribers' ? styles.tabActive : ''}`} onClick={() => go('subscribers')}>Абоненты</button>
        <button className={`${styles.tab} ${tab === 'admin' ? styles.tabActive : ''}`} onClick={() => go('admin')}>Администрирование</button>
      </div>

      {tab === 'main' && <OverviewSection />}
      {tab === 'subscribers' && <SubscribersTab />}
      {tab === 'admin' && <AdminTab />}
    </div>
  );
};
