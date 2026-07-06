import { type FC, useMemo, useState } from 'react';
import { useMtsBusinessAccounts, useAutoLinkMtsBusinessNumberMap, useSetMtsBusinessNumberMap } from '../../../hooks/useMtsBusinessData';
import { useMtsBusinessSubscribers } from '../../../hooks/useMtsBusinessSubscribers';
import { PersonalDataStatusBadge } from '../personal-data/PersonalDataStatusBadge';
import { PersonalDataModal } from '../personal-data/PersonalDataModal';
import { SubscriberDrawer } from './SubscriberDrawer';
import { EmployeeFioPicker } from '../../mts/EmployeeFioPicker';
import { errText, fmtDur, fmtLast, fmtMoney } from '../mtsBusinessFormat';
import st from './Subscribers.module.css';
import styles from '../MtsBusinessPage.module.css';

type Msg = { ok: boolean; text: string } | null;

const norm = (s: string): string => s.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

/**
 * Вкладка «Абоненты МТС» (/mts-business/subscribers): все номера из инвентаря
 * МТС + детализаций, поиск/фильтры, автопривязка к сотрудникам ФОТ, клик по
 * строке — боковая панель управления абонентом.
 */
export const SubscribersTab: FC = () => {
  const accounts = useMtsBusinessAccounts();
  const subscribers = useMtsBusinessSubscribers(true);
  const autoLink = useAutoLinkMtsBusinessNumberMap();
  const setMap = useSetMtsBusinessNumberMap();

  const [search, setSearch] = useState('');
  const [accountId, setAccountId] = useState('');
  const [onlyUnlinked, setOnlyUnlinked] = useState(false);
  const [drawerMsisdn, setDrawerMsisdn] = useState<string | null>(null);
  const [pdMsisdn, setPdMsisdn] = useState<string | null>(null);
  const [manualMsisdn, setManualMsisdn] = useState('');
  const [msg, setMsg] = useState<Msg>(null);

  const rows = useMemo(() => (subscribers.data ?? []).filter(r => r.msisdn != null), [subscribers.data]);

  const filtered = useMemo(() => {
    const q = norm(search);
    return rows.filter(r => {
      if (accountId && r.accountId !== accountId) return false;
      if (onlyUnlinked && r.employeeId != null) return false;
      if (!q) return true;
      const hay = norm([
        r.msisdn, r.mtsFio, r.mtsComment, r.employeeFullName, r.employeeTabNumber, r.tariffName, r.accountLabel,
      ].filter(Boolean).join(' '));
      return hay.includes(q);
    });
  }, [rows, search, accountId, onlyUnlinked]);

  const linkedCount = rows.filter(r => r.employeeId != null).length;
  const drawerRow = drawerMsisdn ? filtered.find(r => r.msisdn === drawerMsisdn) ?? rows.find(r => r.msisdn === drawerMsisdn) ?? null : null;

  const onAutoLink = async (): Promise<void> => {
    setMsg(null);
    try {
      const r = await autoLink.mutateAsync();
      setMsg({ ok: true, text: `Проверено непривязанных с ФИО: ${r.checked}, привязано автоматически: ${r.linked}` });
    } catch (e) {
      setMsg({ ok: false, text: errText(e, 'Ошибка автопривязки (возможно нужен 2FA)') });
    }
  };

  const onManualLink = async (employeeId: number | null): Promise<void> => {
    const m = manualMsisdn.trim();
    if (!m) return;
    setMsg(null);
    try {
      await setMap.mutateAsync({ msisdn: m, employeeId });
      setManualMsisdn('');
      setMsg({ ok: true, text: 'Привязка сохранена' });
    } catch (e) {
      setMsg({ ok: false, text: errText(e, 'Ошибка привязки (возможно нужен 2FA)') });
    }
  };

  return (
    <section className={styles.card}>
      <div className={st.toolbar}>
        <input
          className={st.search}
          type="search"
          placeholder="Поиск: номер, ФИО, сотрудник, тариф, комментарий…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <select className={st.select} value={accountId} onChange={e => setAccountId(e.target.value)}>
          <option value="">Все ЛС</option>
          {(accounts.data ?? []).map(a => (
            <option key={a.id} value={a.id}>{a.label}{a.accountNumber ? ` (${a.accountNumber})` : ''}</option>
          ))}
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

      {filtered.length > 0 && (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Номер</th><th>ФИО (МТС)</th><th>Сотрудник ФОТ</th><th>ЛС</th><th>Тариф</th>
                <th>Баланс</th><th>Начисления</th><th>Услуги</th><th>Звонки</th><th>Время</th><th>Персданные</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(r => (
                <tr key={r.msisdn} className={st.rowClickable} onClick={() => setDrawerMsisdn(r.msisdn)}>
                  <td>{r.msisdn}</td>
                  <td>{r.mtsFio ?? r.mtsComment ?? '—'}</td>
                  <td>
                    {r.employeeFullName
                      ? <>{r.employeeFullName}{r.employeeTabNumber ? ` (таб. ${r.employeeTabNumber})` : ''}</>
                      : <span className={`${styles.badge} ${styles.badgeMuted}`}>не привязан</span>}
                  </td>
                  <td>{r.accountLabel ?? '—'}</td>
                  <td>{r.tariffName ?? '—'}</td>
                  <td>{fmtMoney(r.balance)}</td>
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

      <div className={styles.row} style={{ marginTop: 12 }}>
        <div className={styles.field}>
          <label className={styles.label}>Привязать номер вне списка</label>
          <input className={styles.input} type="text" value={manualMsisdn} onChange={e => setManualMsisdn(e.target.value)} placeholder="79001234567" />
        </div>
        <div className={styles.field}>
          <label className={styles.label}>Сотрудник</label>
          <EmployeeFioPicker
            disabled={setMap.isPending || !manualMsisdn.trim()}
            onSelect={id => { void onManualLink(id); }}
          />
        </div>
      </div>

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
