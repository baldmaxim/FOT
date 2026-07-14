import { type FC, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useMtsBusinessAccounts, useAutoLinkMtsBusinessNumberMap } from '../../../hooks/useMtsBusinessData';
import { useMtsBusinessSubscribers } from '../../../hooks/useMtsBusinessSubscribers';
import { PersonalDataStatusBadge } from '../personal-data/PersonalDataStatusBadge';
import { PersonalDataModal } from '../personal-data/PersonalDataModal';
import { SubscriberDrawer } from './SubscriberDrawer';
import { AutoLinkConflictsModal } from './AutoLinkConflictsModal';
import type { IMtsAutoLinkConflict } from '../../../services/mtsBusinessService';
import type { IMtsSubscriberRow } from '../../../services/mtsBusinessSubscribersService';
import { errText, fmtDur, fmtLast, fmtMoney, fmtPhone } from '../mtsBusinessFormat';
import st from './Subscribers.module.css';
import styles from '../MtsBusinessPage.module.css';

type Msg = { ok: boolean; text: string } | null;

const norm = (s: string): string => s.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
const PAGE_SIZE_OPTIONS = [25, 50, 100, 200];
const NO_DEPT = '__none__';
const COLS_STORAGE_KEY = 'mts-subscribers-columns';

type ColKey = 'num' | 'name' | 'dept' | 'acc' | 'tariff' | 'charges' | 'services' | 'calls' | 'time' | 'pd';

interface IColumn {
  key: ColKey;
  label: string;
  /** Доля ширины (нормируется до 100%). */
  weight: number;
  /** Нельзя скрыть через меню «⋯». */
  pinned?: boolean;
  /** Скрыта по умолчанию. */
  offByDefault?: boolean;
  /** Числовая: без переноса, выравнивание по правому краю. */
  numeric?: boolean;
}

const COLUMNS: IColumn[] = [
  { key: 'num', label: 'Номер', weight: 11, pinned: true },
  { key: 'name', label: 'Абонент', weight: 22, pinned: true },
  { key: 'dept', label: 'Отдел', weight: 15 },
  { key: 'acc', label: 'ЛС', weight: 8, offByDefault: true },
  { key: 'tariff', label: 'Тариф', weight: 15 },
  { key: 'charges', label: 'Начисления', weight: 10, numeric: true },
  { key: 'services', label: 'Услуги', weight: 11, offByDefault: true },
  { key: 'calls', label: 'Звонки', weight: 7, numeric: true },
  { key: 'time', label: 'Время', weight: 8, numeric: true, offByDefault: true },
  { key: 'pd', label: 'Персданные', weight: 10, pinned: true },
];

const DEFAULT_VISIBLE = COLUMNS.filter(c => !c.offByDefault).map(c => c.key);

const loadVisible = (): ColKey[] => {
  try {
    const raw = localStorage.getItem(COLS_STORAGE_KEY);
    if (!raw) return DEFAULT_VISIBLE;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_VISIBLE;
    const keys = COLUMNS.filter(c => c.pinned || parsed.includes(c.key)).map(c => c.key);
    return keys.length > 0 ? keys : DEFAULT_VISIBLE;
  } catch {
    return DEFAULT_VISIBLE;
  }
};

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

/** ФИО сотрудника ФОТ показываем второй строкой только если оно отличается от ФИО в МТС. */
const secondaryName = (r: IMtsSubscriberRow): string | null => {
  if (!r.employeeFullName) return null;
  const mts = r.mtsFio ?? r.mtsComment ?? '';
  const same = mts !== '' && norm(mts) === norm(r.employeeFullName);
  const tab = r.employeeTabNumber ? `таб. ${r.employeeTabNumber}` : '';
  if (same) return tab || null;
  return tab ? `${r.employeeFullName} (${tab})` : r.employeeFullName;
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
  const [visibleCols, setVisibleCols] = useState<ColKey[]>(loadVisible);
  const [colsOpen, setColsOpen] = useState(false);
  const colsRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    localStorage.setItem(COLS_STORAGE_KEY, JSON.stringify(visibleCols));
  }, [visibleCols]);

  useEffect(() => {
    if (!colsOpen) return;
    const onDown = (e: MouseEvent): void => {
      if (colsRef.current && !colsRef.current.contains(e.target as Node)) setColsOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [colsOpen]);

  const cols = useMemo(() => COLUMNS.filter(c => visibleCols.includes(c.key)), [visibleCols]);
  const totalWeight = cols.reduce((s, c) => s + c.weight, 0);

  const toggleCol = (key: ColKey): void => {
    setVisibleCols(prev => (
      prev.includes(key)
        ? prev.filter(k => k !== key)
        : COLUMNS.filter(c => prev.includes(c.key) || c.key === key).map(c => c.key)
    ));
  };

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

  const renderCell = (col: IColumn, r: IMtsSubscriberRow): ReactNode => {
    switch (col.key) {
      case 'num':
        return (
          <a
            className={st.phoneLink}
            href={`tel:+${(r.msisdn ?? '').replace(/\D/g, '')}`}
            onClick={e => e.stopPropagation()}
            title="Позвонить"
          >
            {fmtPhone(r.msisdn)}
          </a>
        );
      case 'name': {
        const primary = r.mtsFio ?? r.mtsComment ?? '—';
        const sub = secondaryName(r);
        return (
          <div className={st.nameCell}>
            <span className={st.nameMain} title={primary}>{primary}</span>
            {sub
              ? <span className={st.nameSub} title={sub}>{sub}</span>
              : r.employeeId == null
                ? <span className={`${styles.badge} ${styles.badgeMuted} ${st.nameBadge}`}>не привязан</span>
                : null}
          </div>
        );
      }
      case 'dept':
        return <span className={st.clip} title={r.departmentName ?? ''}>{r.departmentName ?? '—'}</span>;
      case 'acc':
        return <span className={st.clip} title={r.accountLabel ?? ''}>{r.accountLabel ?? '—'}</span>;
      case 'tariff':
        return <span className={st.clip} title={r.tariffName ?? ''}>{r.tariffName ?? '—'}</span>;
      case 'charges':
        return <>{fmtMoney(r.chargesAmount)}</>;
      case 'services':
        return (
          <span className={st.clip} title={r.servicesCount > 0 ? `${r.servicesCount} услуг · ${fmtMoney(r.servicesMonthlyTotal)}/мес` : ''}>
            {r.servicesCount > 0 ? `${r.servicesCount} · ${fmtMoney(r.servicesMonthlyTotal)}/мес` : '—'}
          </span>
        );
      case 'calls':
        return <>{r.calls}</>;
      case 'time':
        return <>{r.totalSeconds > 0 ? fmtDur(r.totalSeconds) : '—'}</>;
      case 'pd':
        return (
          <button className={styles.linkBtn} onClick={() => setPdMsisdn(r.msisdn)} title="Персональные данные пользователя номера">
            <PersonalDataStatusBadge status={r.pdStatus} />
          </button>
        );
      default:
        return null;
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

        <div className={st.colsMenu} ref={colsRef}>
          <button
            className={st.colsBtn}
            onClick={() => setColsOpen(o => !o)}
            title="Колонки таблицы"
            aria-expanded={colsOpen}
          >
            ⋯
          </button>
          {colsOpen && (
            <div className={st.colsDropdown}>
              <p className={st.colsTitle}>Колонки</p>
              {COLUMNS.map(c => (
                <label key={c.key} className={st.colsItem}>
                  <input
                    type="checkbox"
                    checked={visibleCols.includes(c.key)}
                    disabled={c.pinned}
                    onChange={() => toggleCol(c.key)}
                  />
                  {c.label}
                </label>
              ))}
              <button className={st.colsReset} onClick={() => setVisibleCols(DEFAULT_VISIBLE)}>По умолчанию</button>
            </div>
          )}
        </div>

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
              {cols.map(c => <col key={c.key} style={{ width: `${(c.weight / totalWeight) * 100}%` }} />)}
            </colgroup>
            <thead>
              <tr>
                {cols.map(c => (
                  <th key={c.key} data-col={c.key} className={c.numeric ? st.numCell : undefined}>{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pageRows.map(r => (
                <tr key={r.msisdn} className={st.rowClickable} onClick={() => setDrawerMsisdn(r.msisdn)}>
                  {cols.map(c => (
                    <td
                      key={c.key}
                      data-col={c.key}
                      className={c.numeric ? st.numCell : undefined}
                      onClick={c.key === 'pd' ? e => e.stopPropagation() : undefined}
                    >
                      {renderCell(c, r)}
                    </td>
                  ))}
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
