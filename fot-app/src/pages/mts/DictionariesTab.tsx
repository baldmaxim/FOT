import { type FC } from 'react';
import {
  useMtsSubscriberGroups,
  useMtsCustomFields,
  useMtsSubscribers,
  useMtsConnectionSettings,
} from '../../hooks/useMtsData';
import styles from './MtsPage.module.css';

export const DictionariesTab: FC = () => {
  const connQuery = useMtsConnectionSettings();
  const configured = Boolean(connQuery.data?.hasToken);
  const groupsQuery = useMtsSubscriberGroups(configured);
  const customFieldsQuery = useMtsCustomFields(configured);
  const subsQuery = useMtsSubscribers(configured);

  return (
    <>
      <section className={styles.card}>
        <div className={styles.titleRow}>
          <h2 className={styles.cardTitle}>
            Группы абонентов {groupsQuery.data ? `(${groupsQuery.data.length})` : ''}
          </h2>
          <span className={styles.badgeFree}>бесплатно · GET</span>
        </div>
        {groupsQuery.isError && <p className={styles.err}>Не удалось загрузить группы</p>}
        {groupsQuery.isLoading && <p className={styles.hint}>Загрузка…</p>}
        {groupsQuery.isSuccess && (groupsQuery.data?.length ?? 0) === 0 && (
          <p className={styles.hint}>Групп нет.</p>
        )}
        {(groupsQuery.data?.length ?? 0) > 0 && (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Название</th>
                  <th>Абонентов в группе</th>
                </tr>
              </thead>
              <tbody>
                {(groupsQuery.data ?? []).map(g => {
                  const count = (subsQuery.data ?? []).filter(
                    s => Array.isArray(s.subscriberGroupIDs) && s.subscriberGroupIDs.includes(g.subscriberGroupID),
                  ).length;
                  return (
                    <tr key={g.subscriberGroupID}>
                      <td>{g.subscriberGroupID}</td>
                      <td>{g.name || '—'}</td>
                      <td>{count}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className={styles.card}>
        <div className={styles.titleRow}>
          <h2 className={styles.cardTitle}>
            Шаблоны кастомных полей {customFieldsQuery.data ? `(${customFieldsQuery.data.length})` : ''}
          </h2>
          <span className={styles.badgeFree}>бесплатно · GET</span>
        </div>
        {customFieldsQuery.isError && <p className={styles.err}>Не удалось загрузить кастомные поля</p>}
        {customFieldsQuery.isLoading && <p className={styles.hint}>Загрузка…</p>}
        {customFieldsQuery.isSuccess && (customFieldsQuery.data?.length ?? 0) === 0 && (
          <p className={styles.hint}>Кастомных полей нет.</p>
        )}
        {(customFieldsQuery.data?.length ?? 0) > 0 && (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Название</th>
                  <th>Тип</th>
                  <th>Обязательное</th>
                </tr>
              </thead>
              <tbody>
                {(customFieldsQuery.data ?? []).map((f, idx) => (
                  <tr key={f.customFieldID ?? idx}>
                    <td>{f.customFieldID ?? '—'}</td>
                    <td>{f.name || '—'}</td>
                    <td>{f.type || '—'}</td>
                    <td>{f.isRequired ? 'да' : 'нет'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
};
