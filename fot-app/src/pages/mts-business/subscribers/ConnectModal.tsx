import { type FC, type ReactElement, useState } from 'react';
import { useOverlayDismiss } from '../../../hooks/useOverlayDismiss';
import { useMtsBusinessSubscriberAvailable, useChangeMtsBusinessTariff } from '../../../hooks/useMtsBusinessSubscribers';
import { useModifyMtsBusinessService } from '../../../hooks/useMtsBusinessActionsData';
import type { IMtsSubServiceItem } from '../../../services/mtsBusinessSubscriberService';
import { isMtsUnavailable } from '../../../services/mtsBusinessTypes';
import { UnavailableNotice } from '../common/UnavailableNotice';
import { errText, fmtMoney, fmtPhone } from '../mtsBusinessFormat';
import st from './Subscribers.module.css';
import styles from '../MtsBusinessPage.module.css';

export type ConnectKind = 'service' | 'block' | 'tariff';

const TITLES: Record<ConnectKind, string> = {
  service: 'Подключить услугу',
  block: 'Подключить блокировку',
  tariff: 'Сменить тариф',
};

type Msg = { ok: boolean; text: string } | null;

/**
 * Модалка подключения: доступные услуги / блокировки / тарифы номера (живой
 * каталог МТС, 3 запроса — кэшируется 5 минут) с поиском по названию.
 * Подключение/смена — асинхронная заявка (2FA), статус обновится фоном.
 */
export const ConnectModal: FC<{
  msisdn: string;
  accountId: string;
  kind: ConnectKind;
  onClose: () => void;
}> = ({ msisdn, accountId, kind, onClose }) => {
  const overlay = useOverlayDismiss(onClose);
  const available = useMtsBusinessSubscriberAvailable(msisdn, true);
  const modify = useModifyMtsBusinessService();
  const changeTariff = useChangeMtsBusinessTariff();
  const [search, setSearch] = useState('');
  const [msg, setMsg] = useState<Msg>(null);

  const busy = modify.isPending || changeTariff.isPending;
  const q = search.trim().toLowerCase();

  const onConnect = async (item: IMtsSubServiceItem): Promise<void> => {
    if (!item.code) return;
    const verb = kind === 'block' ? 'Подключить блокировку' : 'Подключить услугу';
    if (!window.confirm(`${verb} «${item.name ?? item.code}» на номере ${fmtPhone(msisdn)}? Потребуется 2FA.`)) return;
    setMsg(null);
    try {
      const r = await modify.mutateAsync({ accountId, msisdn, externalID: item.code, kind: kind === 'block' ? 'block' : 'service', mode: 'add' });
      setMsg({ ok: true, text: `Заявка отправлена (eventId ${r.eventId}) — подключение подтвердится в течение нескольких минут` });
    } catch (e) {
      setMsg({ ok: false, text: errText(e, 'Ошибка (возможно нужен 2FA)') });
    }
  };

  const onTariff = async (tariffId: string | null, name: string | null): Promise<void> => {
    if (!tariffId) return;
    if (!window.confirm(`Перевести номер ${fmtPhone(msisdn)} на тариф «${name ?? tariffId}»? Потребуется 2FA.`)) return;
    setMsg(null);
    try {
      const r = await changeTariff.mutateAsync({ accountId, msisdn, externalID: tariffId });
      setMsg({ ok: true, text: `Заявка на смену тарифа отправлена (eventId ${r.eventId})` });
    } catch (e) {
      setMsg({ ok: false, text: errText(e, 'Ошибка смены тарифа (возможно нужен 2FA)') });
    }
  };

  const renderServices = (): ReactElement | null => {
    const section = kind === 'block' ? available.data?.blocks : available.data?.services;
    if (!section) return null;
    if (isMtsUnavailable(section)) return <UnavailableNotice />;
    if (!('data' in section)) return <p className={styles.err}>Ошибка загрузки каталога.</p>;
    const items = section.data
      .filter(it => !q || `${it.name ?? ''} ${it.code ?? ''}`.toLowerCase().includes(q))
      .sort((a, b) => (b.monthlyAmount ?? 0) - (a.monthlyAmount ?? 0));
    if (items.length === 0) return <p className={styles.hint}>{q ? 'Ничего не найдено по запросу.' : 'Нет доступных для подключения.'}</p>;
    return (
      <ul className={st.list}>
        {items.map((it, i) => (
          <li key={it.code ?? `it-${i}`} className={st.listItem}>
            <span className={st.listName}>{it.name ?? it.code ?? '—'}</span>
            <span className={st.listPrice}>{it.monthlyAmount != null && it.monthlyAmount > 0 ? `${fmtMoney(it.monthlyAmount)}/мес` : 'бесплатно'}</span>
            <button className={st.itemBtn} disabled={busy || !it.code} onClick={() => { void onConnect(it); }}>Подключить</button>
          </li>
        ))}
      </ul>
    );
  };

  const renderTariffs = (): ReactElement | null => {
    const section = available.data?.tariffs;
    if (!section) return null;
    if (isMtsUnavailable(section)) return <UnavailableNotice />;
    if (!('data' in section)) return <p className={styles.err}>Ошибка загрузки каталога.</p>;
    const items = section.data.filter(t => !q || `${t.name ?? ''} ${t.tariffId ?? ''}`.toLowerCase().includes(q));
    if (items.length === 0) return <p className={styles.hint}>{q ? 'Ничего не найдено по запросу.' : 'Нет тарифов, доступных для перехода.'}</p>;
    return (
      <ul className={st.list}>
        {items.map((t, i) => (
          <li key={t.tariffId ?? `t-${i}`} className={st.listItem}>
            <span className={st.listName}>{t.name ?? t.tariffId ?? '—'}</span>
            <span className={st.listPrice}>{t.price != null ? `${fmtMoney(t.price)}/мес` : ''}</span>
            <button className={st.itemBtn} disabled={busy || !t.tariffId} onClick={() => { void onTariff(t.tariffId, t.name); }}>Перейти</button>
          </li>
        ))}
      </ul>
    );
  };

  return (
    <div className={st.connectOverlay} {...overlay}>
      <div className={st.connectModal}>
        <div className={st.drawerHeader}>
          <div>
            <h3 className={st.drawerTitle}>{TITLES[kind]}</h3>
            <p className={st.drawerSub}>{fmtPhone(msisdn)}</p>
          </div>
          <button className={st.drawerClose} onClick={onClose} aria-label="Закрыть">×</button>
        </div>

        <input
          className={st.availSearch}
          type="search"
          placeholder="Поиск по названию…"
          value={search}
          autoFocus
          onChange={e => setSearch(e.target.value)}
        />

        {msg && <p className={msg.ok ? styles.ok : styles.err}>{msg.text}</p>}
        {available.isLoading && <p className={styles.hint}>Загрузка каталога из МТС…</p>}
        {available.isError && <p className={styles.err}>Не удалось загрузить каталог.</p>}
        {kind === 'tariff' ? renderTariffs() : renderServices()}
      </div>
    </div>
  );
};
