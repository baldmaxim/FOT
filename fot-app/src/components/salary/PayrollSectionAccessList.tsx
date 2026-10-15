import { useId, type FC } from 'react';

import { usePayrollSectionAccess } from '../../hooks/usePayrollSectionAccess';
import styles from './PayrollDictionary.module.css';

/**
 * «Доступ к разделу» в окне «Справочник»: кому открыта «Зарплата» (список payroll_section_access,
 * миграция 310). Только просмотр — список ведётся в БД.
 */
export const PayrollSectionAccessList: FC = () => {
  const titleId = useId();
  const users = usePayrollSectionAccess();

  return (
    <section className={`${styles.section} ${styles.accessSection}`} aria-labelledby={titleId}>
      <h3 id={titleId} className={styles.sectionTitle}>Доступ к разделу</h3>

      {!users.data && !users.isError && <p className={styles.state}>Загрузка…</p>}
      {!users.data && users.isError && (
        <p className={`${styles.state} ${styles.stateError}`}>
          Не удалось загрузить
          <button type="button" className={styles.retryButton} onClick={() => { void users.refetch(); }}>
            Повторить
          </button>
        </p>
      )}
      {users.data && users.data.length === 0 && <p className={styles.state}>Список пуст</p>}

      {users.data && users.data.length > 0 && (
        <ul className={styles.list}>
          {users.data.map(user => (
            <li key={user.user_id} className={styles.row}>
              <span className={styles.rowName}>{user.full_name?.trim() || 'Без имени'}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};
