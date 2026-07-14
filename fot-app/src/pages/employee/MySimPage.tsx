import { type FC, useMemo, useState } from 'react';
import { useMySim, useMyForwarding } from '../../hooks/useMySim';
import type { ForwardingType, IForwardingRule, IMySimNumber } from '../../services/mySimService';
import { fmtLast, fmtMoney, fmtPhone } from '../mts-business/mtsBusinessFormat';
import { FORWARDING_TYPE_SHORT, pickForwardingRule } from './sim/forwarding';
import { MySimForwardingModal } from './sim/MySimForwardingModal';
import { MySimUsage } from './sim/MySimUsage';
import styles from './MySimPage.module.css';

/** Карточка одного номера: тариф, абонентская плата, начисления + переадресация. */
const SimCard: FC<{ sim: IMySimNumber; rule: IForwardingRule | null; onForwarding: () => void }> = ({
  sim, rule, onForwarding,
}) => (
  <div className={styles.card}>
    <div className={styles.cardHead}>
      <span className={styles.msisdn}>{fmtPhone(sim.msisdn)}</span>
      <div className={styles.cardHeadRight}>
        {rule && (
          <span className={styles.fwdBadge} title={`Переадресация на ${fmtPhone(rule.forwardingAddress)}`}>
            ↪ Переадресация: {FORWARDING_TYPE_SHORT[rule.forwardingType as ForwardingType]} →{' '}
            {fmtPhone(rule.forwardingAddress)}
          </span>
        )}
        <button className={styles.fwdBtn} onClick={onForwarding}>
          {rule ? 'Настроить переадресацию' : 'Переадресация'}
        </button>
        {sim.capturedAt && <span className={styles.updatedAt}>обновлено {fmtLast(sim.capturedAt)}</span>}
      </div>
    </div>

    <div className={styles.kvGrid}>
      <div className={styles.kv}>
        <span className={styles.kvLabel}>Тариф</span>
        <span className={styles.kvVal}>{sim.tariff.name || '—'}</span>
      </div>
      <div className={styles.kv}>
        <span className={styles.kvLabel}>Абонентская плата</span>
        <span className={styles.kvVal}>
          {sim.tariff.fee?.amount != null ? `${fmtMoney(sim.tariff.fee.amount)}/мес` : '—'}
        </span>
      </div>
      <div className={styles.kv}>
        <span className={styles.kvLabel}>Начисления за месяц</span>
        <span className={styles.kvVal}>{sim.charges ? fmtMoney(sim.charges.amount) : '—'}</span>
      </div>
    </div>
  </div>
);

/**
 * ЛК «Моя SIM»: корпоративный номер сотрудника — тариф, абонентская плата,
 * начисления и статистика использования (звонки/СМС/интернет по дням и
 * построчная детализация). Данные из БД, обновляются ночным прогоном МТС.
 * Персональные данные и баланс лицевого счёта компании сюда не попадают.
 * Переадресация — единственное управляющее действие (кнопка → модалка).
 */
export const MySimPage: FC = () => {
  const { data: sims, isLoading, isError } = useMySim();
  const { data: forwarding } = useMyForwarding();
  const [activeIdx, setActiveIdx] = useState(0);
  const [fwdOpen, setFwdOpen] = useState(false);

  const list = sims ?? [];
  const active = list.length > 0 ? list[Math.min(activeIdx, list.length - 1)] : null;

  const rule = useMemo(() => {
    const entry = forwarding?.find(n => n.msisdn === active?.msisdn);
    return pickForwardingRule(entry?.rules ?? []);
  }, [forwarding, active]);

  if (isLoading) {
    return <div className={styles.page}><p className={styles.hint}>Загрузка…</p></div>;
  }
  if (isError) {
    return <div className={styles.page}><p className={styles.err}>Не удалось загрузить данные SIM.</p></div>;
  }

  if (!active) {
    return (
      <div className={styles.page}>
        <div className={styles.empty}>
          <svg className={styles.emptyIcon} width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M16 2H8a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2z" />
            <line x1="12" y1="18" x2="12" y2="18.01" />
          </svg>
          За вами не закреплена корпоративная SIM-карта.
          <br />
          Если это ошибка — обратитесь к администратору.
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      {list.length > 1 && (
        <div className={styles.numTabs}>
          {list.map((s, i) => (
            <button
              key={s.msisdn}
              className={`${styles.numTab} ${i === activeIdx ? styles.numTabActive : ''}`}
              onClick={() => setActiveIdx(i)}
            >
              {fmtPhone(s.msisdn)}
            </button>
          ))}
        </div>
      )}

      <SimCard sim={active} rule={rule} onForwarding={() => setFwdOpen(true)} />
      <MySimUsage key={active.msisdn} msisdn={active.msisdn} months={active.months} />

      {fwdOpen && <MySimForwardingModal msisdn={active.msisdn} onClose={() => setFwdOpen(false)} />}
    </div>
  );
};
