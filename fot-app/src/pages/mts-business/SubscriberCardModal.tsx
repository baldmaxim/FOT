import { type FC, type ReactNode, useMemo, useState } from 'react';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import {
  useMtsBusinessSubscriberCard,
  useMtsBusinessSubscriberExpenses,
} from '../../hooks/useMtsBusinessSubscriberData';
import type {
  MtsSection,
  IMtsSubServiceItem,
  IMtsSubForwardingRule,
  MtsExpenseCategory,
} from '../../services/mtsBusinessSubscriberService';
import { fmtMoney, fmtLast, EXPENSE_CATEGORY_LABELS, FORWARDING_TYPE_LABELS } from './mtsBusinessFormat';
import s from './SubscriberCardModal.module.css';

const MONTH_NAMES = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

const lastMonths = (n: number): { value: string; label: string }[] => {
  const out: { value: string; label: string }[] = [];
  const d = new Date();
  for (let i = 0; i < n; i++) {
    const y = d.getFullYear();
    const m = d.getMonth();
    out.push({ value: `${y}-${String(m + 1).padStart(2, '0')}`, label: `${MONTH_NAMES[m]} ${y}` });
    d.setMonth(m - 1);
  }
  return out;
};

const dash = (v: string | number | null | undefined): string => (v == null || v === '' ? '—' : String(v));

const KV: FC<{ label: string; value: ReactNode }> = ({ label, value }) => (
  <div className={s.kv}>
    <span className={s.kvLabel}>{label}</span>
    <span className={s.kvVal}>{value}</span>
  </div>
);

// Обёртка секции: данные / «нет в тарифе» / ошибка. state=undefined — загрузка.
function Section<T>({
  title,
  wide,
  state,
  render,
}: {
  title: string;
  wide?: boolean;
  state: MtsSection<T> | undefined;
  render: (data: T) => ReactNode;
}): ReactNode {
  const unavailable = state != null && 'unavailable' in state;
  return (
    <div className={`${s.section}${wide ? ` ${s.sectionWide}` : ''}`}>
      <div className={s.sectionHead}>
        <h4 className={s.sectionTitle}>{title}</h4>
        {unavailable && <span className={s.badge}>Не подключено в тарифе</span>}
      </div>
      {state == null ? (
        <p className={s.hint}>Загрузка…</p>
      ) : 'unavailable' in state ? null : 'error' in state ? (
        <p className={s.err}>Нет данных ({state.error})</p>
      ) : (
        render(state.data)
      )}
    </div>
  );
}

const ServiceList: FC<{ items: IMtsSubServiceItem[]; emptyText: string }> = ({ items, emptyText }) => {
  if (items.length === 0) return <p className={s.itemMuted}>{emptyText}</p>;
  return (
    <ul className={s.list}>
      {items.map((it, i) => (
        <li key={it.code ?? `it-${i}`} className={s.listItem}>
          <span>{dash(it.name ?? it.code)}</span>
          <span>{it.monthlyAmount != null ? fmtMoney(it.monthlyAmount) : ''}</span>
        </li>
      ))}
    </ul>
  );
};

const ForwardingList: FC<{ rules: IMtsSubForwardingRule[] }> = ({ rules }) => {
  if (rules.length === 0) return <p className={s.itemMuted}>Переадресация не настроена</p>;
  return (
    <ul className={s.list}>
      {rules.map((r, i) => (
        <li key={`${r.forwardingType ?? 'fw'}-${i}`} className={s.listItem}>
          <span>{(r.forwardingType && FORWARDING_TYPE_LABELS[r.forwardingType]) ?? r.forwardingType ?? '—'}</span>
          <span>{dash(r.forwardingAddress)}</span>
        </li>
      ))}
    </ul>
  );
};

const EXPENSE_ORDER: MtsExpenseCategory[] = ['calls', 'sms', 'internet', 'periodic', 'oneTime', 'topups', 'other'];

export const SubscriberCardModal: FC<{ msisdn: string; onClose: () => void }> = ({ msisdn, onClose }) => {
  const overlay = useOverlayDismiss(onClose);
  const months = useMemo(() => lastMonths(6), []);
  const [month, setMonth] = useState(months[0].value);
  const card = useMtsBusinessSubscriberCard(msisdn);
  const expenses = useMtsBusinessSubscriberExpenses(msisdn, month, true);
  const data = card.data;
  const id = data?.identity;

  const subtitle = id
    ? [id.fio, id.employeeTabNumber ? `таб. ${id.employeeTabNumber}` : null, id.region].filter(Boolean).join(' · ')
    : '';

  return (
    <div className={s.overlay} {...overlay}>
      <div className={s.modal}>
        <div className={s.header}>
          <div>
            <h3 className={s.title}>{msisdn}</h3>
            {subtitle && <p className={s.subtitle}>{subtitle}</p>}
          </div>
          <button className={s.close} onClick={onClose} aria-label="Закрыть">×</button>
        </div>

        {card.isLoading && <p className={s.hint}>Загрузка карточки…</p>}
        {card.isError && <p className={s.err}>Не удалось загрузить карточку.</p>}

        {data && id && (
          <>
            {id.stale && (
              <div className={s.stale}>
                Структура абонента отсутствует в снапшоте — IMSI/SIM/договор могут быть пустыми. Обновите каталог кнопкой «Обновить каталог» на вкладке «Основное».
              </div>
            )}

            <div className={s.grid}>
              <div className={`${s.section} ${s.sectionWide}`}>
                <div className={s.sectionHead}><h4 className={s.sectionTitle}>Идентификация</h4></div>
                <KV label="Номер" value={dash(id.msisdn)} />
                <KV label="ФИО" value={dash(id.fio)} />
                <KV label="Сотрудник ФОТ" value={id.employeeFullName ? `${id.employeeFullName}${id.employeeTabNumber ? ` (таб. ${id.employeeTabNumber})` : ''}` : '—'} />
                <KV label="Лицевой счёт" value={dash(id.accountNo)} />
                <KV label="Договор" value={dash(id.contractId)} />
                <KV label="Организация" value={dash(id.organizationName)} />
                <KV label="Регион" value={dash(id.region)} />
                <KV label="IMSI" value={dash(id.imsi)} />
                <KV label="SIM/ICCID" value={dash(id.iccid ?? id.sim)} />
                <KV label="ИНН" value={dash(id.inn)} />
                <KV label="КПП" value={dash(id.kpp)} />
              </div>

              <Section title="Баланс" state={data.balance} render={b => (
                <>
                  <KV label="Баланс" value={fmtMoney(b.amount)} />
                  <KV label="Кредитный лимит" value={fmtMoney(b.creditLimit)} />
                  <KV label="Действует до" value={fmtLast(b.validUntil)} />
                </>
              )} />

              <Section title="Тариф" state={data.tariff} render={t => (
                <>
                  <KV label="Тариф" value={dash(t.name)} />
                  <KV label="Абонплата" value={t.fee?.amount != null ? fmtMoney(t.fee.amount) : '—'} />
                </>
              )} />

              <Section title="Начисления (текущие)" state={data.currentCharges} render={c => (
                c ? (
                  <>
                    <KV label="Сумма" value={fmtMoney(c.amount)} />
                    <KV label="Период" value={c.periodStart ? `${fmtLast(c.periodStart)} — ${fmtLast(c.periodEnd)}` : '—'} />
                  </>
                ) : <p className={s.itemMuted}>Нет начислений</p>
              )} />

              <Section title="Роуминг / локация" state={data.roaming} render={r => (
                <>
                  <KV label="Страна" value={dash(r.countryName ?? r.countryId)} />
                  <KV label="Международный роуминг" value={r.isInternational ? <span className={s.badge}>Да</span> : <span className={`${s.badge} ${s.badgeOk}`}>Нет</span>} />
                </>
              )} />

              <Section title="Способ доставки счёта" state={data.deliveryMethod} render={list => (
                list.length === 0 ? <p className={s.itemMuted}>Не задан</p> : (
                  <ul className={s.list}>
                    {list.map((d, i) => (
                      <li key={`dm-${i}`} className={s.listItem}>
                        <span>{dash(d.method)}</span>
                        <span>{dash(d.address ?? d.documentFormat)}</span>
                      </li>
                    ))}
                  </ul>
                )
              )} />

              <Section title="Переадресация" state={data.forwarding} render={rules => <ForwardingList rules={rules} />} />

              <Section title="Подключённые услуги" wide state={data.connectedServices} render={items => <ServiceList items={items} emptyText="Платных услуг нет" />} />
              <Section title="Подключённые блокировки" state={data.connectedBlocks} render={items => <ServiceList items={items} emptyText="Блокировок нет" />} />
              <Section title="Доступные услуги" state={data.availableServices} render={items => <ServiceList items={items} emptyText="Нет доступных" />} />
              <Section title="Доступные блокировки" state={data.availableBlocks} render={items => <ServiceList items={items} emptyText="Нет доступных" />} />
            </div>

            <div className={`${s.section} ${s.sectionWide}`} style={{ marginTop: 12 }}>
              <div className={s.sectionHead}>
                <h4 className={s.sectionTitle}>Расходы за месяц</h4>
                <select className={s.monthSelect} value={month} onChange={e => setMonth(e.target.value)}>
                  {months.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
              </div>
              {expenses.isLoading && <p className={s.hint}>Загрузка…</p>}
              {expenses.isError && <p className={s.err}>Не удалось загрузить расходы.</p>}
              {expenses.data && (
                <>
                  {EXPENSE_ORDER.map(cat => {
                    const b = expenses.data.summary[cat];
                    return (
                      <div key={cat} className={s.expenseRow}>
                        <span>{EXPENSE_CATEGORY_LABELS[cat]}{b.count ? ` · ${b.count}` : ''}</span>
                        <span>{fmtMoney(b.amount)}</span>
                      </div>
                    );
                  })}
                  <div className={s.expenseTotal}>
                    <span>Итого расходов</span>
                    <span>{fmtMoney(expenses.data.summary.total)}</span>
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
};
