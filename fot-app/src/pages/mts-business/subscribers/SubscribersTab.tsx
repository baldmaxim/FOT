import { type FC, useMemo, useState } from 'react';
import { useMtsBusinessAccounts, useAutoLinkMtsBusinessNumberMap } from '../../../hooks/useMtsBusinessData';
import { useMtsBusinessSubscribers } from '../../../hooks/useMtsBusinessSubscribers';
import { PersonalDataStatusBadge } from '../personal-data/PersonalDataStatusBadge';
import { PersonalDataModal } from '../personal-data/PersonalDataModal';
import { SubscriberDrawer } from './SubscriberDrawer';
import { errText, fmtDur, fmtLast, fmtMoney, fmtPhone } from '../mtsBusinessFormat';
import st from './Subscribers.module.css';
import styles from '../MtsBusinessPage.module.css';

type Msg = { ok: boolean; text: string } | null;

const norm = (s: string): string => s.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
const PAGE_SIZE = 50;
const NO_DEPT = '__none__';

/**
 * Вкладка «Абоненты МТС» (/mts-business/subscribers): все номера из инвентаря
 * МТС + детализаций, поиск/фильтры (ЛС, отдел ФОТ), пагинация, автопривязка к
 * сотрудникам, клик по строке — боковая панель управления абонентом.
 */
export const SubscribersTab: FC = () => {
  const accounts = useMtsBusinessAccounts();
  const subscribers = useMtsBusinessSubscribers(true);
  const autoLink = useAutoLinkMtsBusinessNumberMap();

  const [search, setSearch] = useState('');
  const [accountId, setAccountId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [onlyUnlinked, setOnlyUnlinked] = useState(false);
  // Страница хранится вместе с «подписью» фильтров: смена любого фильтра
  // возвращает на первую страницу без setState-в-эффекте.
  const [pageState, setPageState] = useState<{ key: string; page: number }>({ key: '', page: 1 });
  const [drawerMsisdn, setDrawerMsisdn] = useState<string | null>(null);
  const [pdMsisdn, setPdMsisdn] = useState<string | null>(null);
  const [msg, setMsg] = useState<Msg>(null);

  const rows = useMemo(() => (subscribers.data ?? []).filter(r => r.msisdn != null), [subscribers.data]);

  const departments = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of rows) {
      if (r.departmentId && r.departmentName) map.set(r.departmentId, r.departmentName);
    }
    return [...map.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  }, [rows]);

  const filtered = useMemo(() => {
    const q = norm(search);
    return rows.filter(r => {
      if (accountId && r.accountId !== accountId) return false;
      if (departmentId === NO_DEPT && r.departmentId != null) return false;
      if (departmentId && departmentId !== NO_DEPT && r.departmentId !== departmentId) return false;
      if (onlyUnlinked && r.employeeId != null) return false;
      if (!q) return true;
      const hay = norm([
        r.msisdn, r.mtsFio, r.mtsComment, r.employeeFullName, r.employeeTabNumber,
        r.tariffName, r.accountLabel, r.departmentName,
      ].filter(Boolean).join(' '));
      return hay.includes(q);
    });
  }, [rows, search, accountId, departmentId, onlyUnlinked]);

  const filtersKey = `${search}|${accountId}|${departmentId}|${onlyUnlinked}`;
  const page = pageState.key === filtersKey ? pageState.page : 1;
  const setPage = (p: number): void => setPageState({ key: filtersKey, page: p });
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pageRows = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const linkedCount = rows.filter(r => r.employeeId != null).length;
  const drawerRow = drawerMsisdn ? rows.find(r => r.msisdn === drawerMsisdn) ?? null : null;

  const onAutoLink = async (): Promise<void> => {
    setMsg(null);
    try {
      const r = await autoLink.mutateAsync();
      setMsg({ ok: true, text: `Проверено непривязанных с ФИО: ${r.checked}, привязано автоматически: ${r.linked}` });
    } catch (e) {
      setMsg({ ok: false, text: errText(e, 'Ошибка автопривязки (возможно нужен 2FA)') });
    }
  };

  return (
    <section className={styles.card}>
      <div className={st.toolbar}>
        <input
          className={st.search}
          type="search"
          placeholder="Поиск: номер, ФИО, сотрудник, тариф…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <select className={st.select} value={accountId} onChange={e => setAccountId(e.target.value)}>
          <option value="">Все ЛС</option>
          {(accounts.data ?? []).map(a => (
            <option key={a.id} value={a.id}>{a.label}{a.accountNumber ? ` (${a.accountNumber})` : ''}</option>
          ))}
        </select>
        <select className={st.select} value={departmentId} onChange={e => setDepartmentId(e.target.value)}>
          <option value="">Все отделы</option>
          <option value={NO_DEPT}>Без отдела / не привязан</option>
          {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <label className={st.checkLabel}>
          <input type="checkbox" checked={onlyUnlinked} onChange={e => setOnlyUnlinked(e.target.checked)} />
          только непривязанные
        </label>
        <button className={styles.btnSecondary} onClick={() => { void onAutoLink(); }} disabled={autoLink.isPending}>
          Автосвязать по ФИО
        </button>
        <span className={st.counts}>
          {filtered.length} из {rows.length} · привязано {linkedCount}
        </span>
      </div>

      {msg && <p className={msg.ok ? styles.ok : styles.err}>{msg.text}</p>}
      {subscribers.isLoading && <p className={styles.hint}>Загрузка…</p>}
      {!subscribers.isLoading && rows.length === 0 && (
        <p className={styles.hint}>Абонентов пока нет — нажмите «Обновить» на вкладке «Основное», чтобы выгрузить номера из МТС.</p>
      )}

      {pageRows.length > 0 && (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Номер</th><th>ФИО (МТС)</th><th>Сотрудник ФОТ</th><th>Отдел</th><th>ЛС</th><th>Тариф</th>
                <th>Начисления</th><th>Услуги</th><th>Звонки</th><th>Время</th><th>Персданные</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map(r => (
                <tr key={r.msisdn} className={st.rowClickable} onClick={() => setDrawerMsisdn(r.msisdn)}>
                  <td>
                    <a
                      className={st.phoneLink}
                      href={`tel:+${(r.msisdn ?? '').replace(/\D/g, '')}`}
                      onClick={e => e.stopPropagation()}
                      title="Позвонить"
                    >
                      {fmtPhone(r.msisdn)}
                    </a>
                  </td>
                  <td>{r.mtsFio ?? r.mtsComment ?? '—'}</td>
                  <td>
                    {r.employeeFullName
                      ? <>{r.employeeFullName}{r.employeeTabNumber ? ` (таб. ${r.employeeTabNumber})` : ''}</>
                      : <span className={`${styles.badge} ${styles.badgeMuted}`}>не привязан</span>}
                  </td>
                  <td>{r.departmentName ?? '—'}</td>
                  <td>{r.accountLabel ?? '—'}</td>
                  <td>{r.tariffName ?? '—'}</td>
                  <td>{fmtMoney(r.chargesAmount)}</td>
                  <td>{r.servicesCount > 0 ? `${r.servicesCount} · ${fmtMoney(r.servicesMonthlyTotal)}/мес` : '—'}</td>
                  <td>{r.calls}</td>
                  <td>{r.totalSeconds > 0 ? fmtDur(r.totalSeconds) : '—'}</td>
                  <td onClick={e => e.stopPropagation()}>
                    <button className={styles.linkBtn} onClick={() => setPdMsisdn(r.msisdn)} title="Персональные данные пользователя номера">
                      <PersonalDataStatusBadge status={r.pdStatus} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!subscribers.isLoading && rows.length > 0 && filtered.length === 0 && (
        <p className={styles.hint}>Ничего не найдено по заданным фильтрам.</p>
      )}

      {pageCount > 1 && (
        <div className={st.pager}>
          <button className={styles.btnSecondary} disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}>‹ Назад</button>
          <span className={st.pagerInfo}>
            {safePage} / {pageCount} · строки {(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, filtered.length)}
          </span>
          <button className={styles.btnSecondary} disabled={safePage >= pageCount} onClick={() => setPage(safePage + 1)}>Вперёд ›</button>
        </div>
      )}

      <p className={styles.hint} style={{ marginTop: 8 }}>
        Данные обновляются кнопкой «Обновить» на вкладке «Основное» (все абоненты) или из панели абонента
        («Обновить данные из МТС»). Последняя выгрузка: {fmtLast(rows.reduce<string | null>((max, r) => (r.capturedAt && (!max || r.capturedAt > max) ? r.capturedAt : max), null))}
      </p>

      {drawerRow && drawerRow.msisdn && (
        <SubscriberDrawer row={drawerRow} onClose={() => setDrawerMsisdn(null)} />
      )}
      {pdMsisdn && <PersonalDataModal msisdn={pdMsisdn} onClose={() => setPdMsisdn(null)} />}
    </section>
  );
};
