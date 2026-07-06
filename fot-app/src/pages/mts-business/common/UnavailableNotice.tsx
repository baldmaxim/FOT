import { type FC } from 'react';
import styles from './UnavailableNotice.module.css';

interface IUnavailableNoticeProps {
  compact?: boolean;
  message?: string;
}

/**
 * Единый паттерн «Не подключено в тарифе МТС» (апстрим ответил 403/errorCode
 * 1010): полный плейсхолдер для секций и compact-бейдж для ячеек/шагов.
 * Это не ошибка портала — продукт подключается менеджером МТС.
 */
export const UnavailableNotice: FC<IUnavailableNoticeProps> = ({ compact = false, message }) => {
  if (compact) {
    return (
      <span className={styles.pill} title={message ?? 'Продукт не активирован для этого лицевого счёта'}>
        Не подключено в тарифе МТС
      </span>
    );
  }
  return (
    <div className={styles.box}>
      <div className={styles.title}>Не подключено в тарифе МТС</div>
      <p className={styles.text}>
        {message ?? 'Продукт не активирован для этого лицевого счёта. Обратитесь к менеджеру МТС для подключения.'}
      </p>
    </div>
  );
};
