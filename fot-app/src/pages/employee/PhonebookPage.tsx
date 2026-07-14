import { type FC, useMemo, useState } from 'react';
import { usePhonebook } from '../../hooks/useMySim';
import { fmtPhone } from '../mts-business/mtsBusinessFormat';
import styles from './PhonebookPage.module.css';

const normText = (s: string): string => s.toLowerCase().replace(/ё/g, 'е').trim();
const digitsOf = (s: string): string => s.replace(/\D/g, '');

/**
 * ЛК «Телефонная книга»: полный список привязанных корпоративных номеров
 * (активные сотрудники) с поиском по номеру или ФИО. Только таблица
 * номер/ФИО/должность/отдел — без карточек, статистики и ссылок.
 */
export const PhonebookPage: FC = () => {
  const { data: rows, isLoading, isError } = usePhonebook();
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    const list = rows ?? [];
    const q = normText(search);
    if (!q) return list;
    const qDigits = digitsOf(q);
    return list.filter(r => {
      if (qDigits.length >= 3 && r.msisdn && digitsOf(r.msisdn).includes(qDigits)) return true;
      return normText(`${r.fullName} ${r.positionName ?? ''} ${r.departmentName ?? ''}`).includes(q);
    });
  }, [rows, search]);

  return (
    <div className={styles.page}>
      <div className={styles.searchWrap}>
        <input
          type="search"
          className={styles.search}
          placeholder="Поиск по номеру или ФИО…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          aria-label="Поиск по номеру телефона или ФИО"
        />
        {rows && <span className={styles.counter}>{filtered.length} из {rows.length}</span>}
      </div>

      {isLoading && <p className={styles.hint}>Загрузка…</p>}
      {isError && <p className={styles.err}>Не удалось загрузить телефонную книгу.</p>}

      {rows && (filtered.length === 0
        ? <p className={styles.hint}>{search ? 'Ничего не найдено.' : 'Телефонная книга пуста.'}</p>
        : (
          <>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Номер</th>
                    <th>ФИО</th>
                    <th>Должность</th>
                    <th>Отдел</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(r => (
                    <tr key={`${r.employeeId}-${r.msisdn ?? ''}`}>
                      <td className={styles.phoneCell}>{fmtPhone(r.msisdn)}</td>
                      <td className={styles.nameCell}>{r.fullName}</td>
                      <td>{r.positionName ?? '—'}</td>
                      <td>{r.departmentName ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className={styles.cards}>
              {filtered.map(r => (
                <div key={`${r.employeeId}-${r.msisdn ?? ''}`} className={styles.cardRow}>
                  <span className={styles.cardPhone}>{fmtPhone(r.msisdn)}</span>
                  <span className={styles.cardName}>{r.fullName}</span>
                  <span className={styles.cardMeta}>
                    {[r.positionName, r.departmentName].filter(Boolean).join(' · ') || '—'}
                  </span>
                </div>
              ))}
            </div>
          </>
        )
      )}
    </div>
  );
};
