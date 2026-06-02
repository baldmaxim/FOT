import { type FC, useState } from 'react';
import { useVersionCheck } from '../../hooks/useVersionCheck';
import styles from './AppUpdateBanner.module.css';

// Глобальный баннер «доступна новая версия». Появляется, когда открытая вкладка/PWA
// работает на устаревшем бандле после деплоя (см. useVersionCheck). Перезагрузка
// подтягивает свежий код — это устраняет создание заявлений старым payload'ом.
export const AppUpdateBanner: FC = () => {
  const { updateAvailable } = useVersionCheck();
  const [dismissed, setDismissed] = useState(false);

  if (!updateAvailable || dismissed) return null;

  return (
    <div className={styles.banner} role="status">
      <span className={styles.text}>Доступна новая версия приложения</span>
      <div className={styles.actions}>
        <button type="button" className={styles.reload} onClick={() => window.location.reload()}>
          Обновить
        </button>
        <button type="button" className={styles.later} onClick={() => setDismissed(true)}>
          Позже
        </button>
      </div>
    </div>
  );
};
