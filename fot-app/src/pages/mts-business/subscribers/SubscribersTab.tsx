import { type FC, useMemo, useState } from 'react';
import { useMtsBusinessAccounts, useAutoLinkMtsBusinessNumberMap } from '../../../hooks/useMtsBusinessData';
import { useMtsBusinessSubscribers } from '../../../hooks/useMtsBusinessSubscribers';
import { PersonalDataStatusBadge } from '../personal-data/PersonalDataStatusBadge';
import { PersonalDataModal } from '../personal-data/PersonalDataModal';
import { SubscriberDrawer } from './SubscriberDrawer';
import { AutoLinkConflictsModal } from './AutoLinkConflictsModal';
import type { IMtsAutoLinkConflict } from '../../../services/mtsBusinessService';
import { errText, fmtDur, fmtLast, fmtMoney, fmtPhone } from '../mtsBusinessFormat';
import st from './Subscribers.module.css';
import styles from '../MtsBusinessPage.module.css';

type Msg = { ok: boolean; text: string } | null;

const norm = (s: string): string => s.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
const PAGE_SIZE_OPTIONS = [25, 50, 100, 200];
const NO_DEPT = '__none__';

/** Компактный ряд номеров страниц с усечением: 1 … 4 5 [6] 7 8 … 20. */
const buildPageList = (total: number, current: number): (number | '…')[] => {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages: (number | '…')[] = [1];
  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);
  if (start > 2) pages.push('…');
  for (let p = start; p <= end; p++) pages.push(p);
  if (end < total - 1) pages.push('…');
  pages.push(total);
  return pages;
};

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
  const [pageSize, setPageSize] = useState(50);
  // Страница хранится вместе с «подписью» фильтров: смена любого фильтра
  // (в т.ч. размера страницы) возвращает на первую страницу без setState-в-эффекте.
  const [pageState, setPageState] = useState<{ key: string; page: number }>({ key: '', page: 1 });
  const [drawerMsisdn, setDrawerMsisdn] = useState<string | null>(null);
  const [pdMsisdn, setPdMsisdn] = useState<string | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const [conflicts, setConflicts] = useState<IMtsAutoLinkConflict[]>([]);

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

  const filtersKey = `${search}|${accountId}|${departmentId}|${onlyUnlinked}|${pageSize}`;
  const page = pageState.key === filtersKey ? pageState.page : 1;
  const setPage = (p: number): void => setPageState({ key: filtersKey, page: p });
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const pageRows = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  const linkedCount = rows.filter(r => r.employeeId != null).length;
  const drawerRow = drawerMsisdn ? rows.find(r => r.msisdn === drawerMsisdn) ?? null : null;

  const onAutoLink = async (): Promise<void> => {
    setMsg(null);
    try {
      const r = await autoLink.mutateAsync();
      const parts = [`Проверено с ФИО: ${r.checked}`, `привязано: ${r.linked}`, `перепривязано: ${r.relinked}`, `снято: ${r.cleared}`];
      if (r.conflicts.length > 0) parts.push(`конфликтов: ${r.conflicts.length}`);
      setMsg({ ok: true, text: parts.join(', ') });
      setConflicts(r.conflicts);
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
          <table className={`${styles.table} ${st.subsTable}`}>
            <colgroup>
              <col className={st.colNum} />
              <col className={st.colFio} />
              <col className={st.colEmp} />
              <col className={st.colDept} />
              <col className={st.colAcc} />
              <col className={st.colTariff} />
              <col className={st.colCharges} />
              <col className={st.colServices} />
              <col className={st.colCalls} />
              <col className={st.colTime} />
              <col className={st.colPd} />
            </colgroup>
            <thead>
              <tr>
                <th>Номер</th><th>ФИО (МТС)</th><th>Сотрудник ФОТ</th><th>Отдел</th><th>ЛС</th><th>Тариф</th>
                <th>Начисления (месяц)</th><th>Услуги</th><th>Звонки</th><th>Время</th><th>Персданные</th>
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

      {filtered.length > 0 && (
        <div className={st.pager}>
          <label className={st.pageSizeLabel}>
            Показывать
            <select
              className={st.pageSizeSelect}
              value={pageSize}
              onChange={e => setPageSize(Number(e.target.value))}
            >
              {PAGE_SIZE_OPTIONS.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>

          {pageCount > 1 && (
            <div className={st.pageNums}>
              <button className={st.pageNum} disabled={safePage <= 1} onClick={() => setPage(safePage - 1)} aria-label="Назад">‹</button>
              {buildPageList(pageCount, safePage).map((p, i) => (
                p === '…'
                  ? <span key={`gap-${i}`} className={st.pagerEllipsis}>…</span>
                  : <button
                      key={p}
                      className={`${st.pageNum} ${p === safePage ? st.pageNumActive : ''}`}
                      onClick={() => setPage(p)}
                    >{p}</button>
              ))}
              <button className={st.pageNum} disabled={safePage >= pageCount} onClick={() => setPage(safePage + 1)} aria-label="Вперёд">›</button>
            </div>
          )}

          <span className={st.pagerInfo}>
            строки {(safePage - 1) * pageSize + 1}–{Math.min(safePage * pageSize, filtered.length)} из {filtered.length}
          </span>
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
      {conflicts.length > 0 && (
        <AutoLinkConflictsModal conflicts={conflicts} onClose={() => setConflicts([])} />
      )}
    </section>
  );
};
