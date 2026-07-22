import { type FC, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useOverlayDismiss } from '../../../hooks/useOverlayDismiss';
import {
  useSetMtsBusinessForwarding,
  useDeleteMtsBusinessForwarding,
  getMtsBusinessSubscriberDetailsKey,
  getMtsBusinessSubscribersKey,
} from '../../../hooks/useMtsBusinessSubscribers';
import { useMtsBusinessActions } from '../../../hooks/useMtsBusinessActionsData';
import {
  MTS_FORWARDING_TYPES,
  MTS_DEFAULT_NO_REPLY_TIMER,
  isMtsForwardingType,
  pickMtsForwardingRule,
  type IMtsSubForwardingRule,
  type IForwardingResult,
  type MtsForwardingType,
} from '../../../services/mtsBusinessSubscriberService';
import { mtsErrText, fmtPhone, FORWARDING_TYPE_LABELS } from '../mtsBusinessFormat';
import st from './Subscribers.module.css';
import styles from '../MtsBusinessPage.module.css';

type Msg = { ok: boolean; text: string } | null;

const TIMER_OPTIONS = [5, 10, 15, 20, 25, 30];

/**
 * Управление переадресацией ЗА абонента (тот же ChangeCallForwarding, что в ЛК
 * «Моя SIM»). Три исхода от бэкенда:
 *  - queued  — заявка принята, следим за ней в журнале (useMtsBusinessActions
 *    поллит, пока есть in_progress) и по completed перезапрашиваем детали;
 *  - applied — правило уже применено, сразу обновляем детали и список;
 *  - unknown — МТС не подтвердил исход: показываем предупреждение и НЕ даём
 *    нажать ещё раз, чтобы не отправить внешнюю мутацию повторно.
 */
export const SubscriberForwardingModal: FC<{
  msisdn: string;
  accountId: string;
  rules: IMtsSubForwardingRule[];
  onClose: () => void;
}> = ({ msisdn, accountId, rules, onClose }) => {
  const overlay = useOverlayDismiss(onClose);
  const qc = useQueryClient();
  const setForwarding = useSetMtsBusinessForwarding();
  const deleteForwarding = useDeleteMtsBusinessForwarding();

  const rule = useMemo(() => pickMtsForwardingRule(rules), [rules]);

  const [type, setType] = useState<MtsForwardingType>(
    isMtsForwardingType(rule?.forwardingType) ? rule.forwardingType : 'CFU',
  );
  const [target, setTarget] = useState(rule?.forwardingAddress ? fmtPhone(rule.forwardingAddress) : '');
  const [timer, setTimer] = useState(rule?.noReplyTimer ?? MTS_DEFAULT_NO_REPLY_TIMER);
  const [pendingEventId, setPendingEventId] = useState<string | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  // Исход в МТС не подтверждён — форму запираем до ручного обновления.
  const [locked, setLocked] = useState(false);

  const actions = useMtsBusinessActions(Boolean(pendingEventId));
  const pending = pendingEventId ? actions.data?.find(a => a.eventId === pendingEventId) ?? null : null;

  // Заявка доехала — обновляем правила номера и список (бейдж переадресации).
  useEffect(() => {
    if (!pending || pending.status === 'in_progress') return;
    setPendingEventId(null);
    if (pending.status === 'completed') {
      setMsg({ ok: true, text: 'Переадресация применена' });
      void qc.invalidateQueries({ queryKey: getMtsBusinessSubscriberDetailsKey(msisdn) });
      void qc.invalidateQueries({ queryKey: getMtsBusinessSubscribersKey() });
    } else if (pending.status === 'unknown') {
      setLocked(true);
      setMsg({ ok: false, text: 'МТС не подтвердил исход заявки. Не повторяйте операцию — проверьте состояние номера позже.' });
    } else {
      setMsg({ ok: false, text: 'МТС отклонил заявку на переадресацию' });
    }
  }, [pending, qc, msisdn]);

  const busy = Boolean(pendingEventId) || locked || setForwarding.isPending || deleteForwarding.isPending;
  const targetDigits = target.replace(/\D/g, '');

  const refreshSubscriber = (): void => {
    void qc.invalidateQueries({ queryKey: getMtsBusinessSubscriberDetailsKey(msisdn) });
    void qc.invalidateQueries({ queryKey: getMtsBusinessSubscribersKey() });
  };

  /** Общая развилка исходов для включения и снятия. */
  const handleResult = (r: IForwardingResult, queuedText: string, appliedText: string): void => {
    if (r.outcome === 'queued' && r.eventId) {
      setPendingEventId(r.eventId);
      setMsg({ ok: true, text: `${queuedText} (eventId ${r.eventId}) — МТС применит её в течение нескольких минут` });
      return;
    }
    if (r.outcome === 'applied') {
      refreshSubscriber();
      setMsg({
        ok: true,
        text: r.tracking ? appliedText : `${appliedText}. Состояние в портале обновится позже`,
      });
      return;
    }
    setLocked(true);
    setMsg({
      ok: false,
      text: 'МТС принял запрос, но результат пока не подтверждён. Не повторяйте операцию — обновите состояние номера через несколько минут.',
    });
  };

  const onSave = async (): Promise<void> => {
    if (!window.confirm(`Включить переадресацию с номера ${fmtPhone(msisdn)} на ${fmtPhone(targetDigits)}? Потребуется 2FA.`)) return;
    setMsg(null);
    try {
      const r = await setForwarding.mutateAsync({
        accountId,
        msisdn,
        type,
        target: targetDigits,
        timer: type === 'CFNRY' ? timer : undefined,
      });
      handleResult(r, 'Заявка отправлена', 'Переадресация применена');
    } catch (e) {
      setMsg({ ok: false, text: mtsErrText(e, 'Не удалось включить переадресацию') });
    }
  };

  const onDelete = async (): Promise<void> => {
    if (!rule || !isMtsForwardingType(rule.forwardingType)) return;
    if (!window.confirm(`Снять переадресацию с номера ${fmtPhone(msisdn)}? Потребуется 2FA.`)) return;
    setMsg(null);
    try {
      const r = await deleteForwarding.mutateAsync({ accountId, msisdn, type: rule.forwardingType });
      handleResult(r, 'Заявка на снятие отправлена', 'Переадресация снята');
    } catch (e) {
      setMsg({ ok: false, text: mtsErrText(e, 'Не удалось отключить переадресацию') });
    }
  };

  return (
    <div className={st.connectOverlay} {...overlay}>
      <div className={st.connectModal} role="dialog" aria-modal="true" aria-label="Переадресация звонков">
        <div className={st.drawerHeader}>
          <div>
            <h3 className={st.drawerTitle}>Переадресация звонков</h3>
            <p className={st.drawerSub}>{fmtPhone(msisdn)}</p>
          </div>
          <button className={st.drawerClose} onClick={onClose} aria-label="Закрыть">×</button>
        </div>

        {msg && <p className={msg.ok ? styles.ok : styles.err}>{msg.text}</p>}

        <p className={st.fwdState}>
          {rule ? (
            <>
              Сейчас: <strong>{FORWARDING_TYPE_LABELS[rule.forwardingType ?? ''] ?? rule.forwardingType}</strong> на{' '}
              <strong>{fmtPhone(rule.forwardingAddress)}</strong>
              {rule.forwardingType === 'CFNRY' && rule.noReplyTimer ? ` (через ${rule.noReplyTimer} сек)` : ''}
            </>
          ) : (
            'Сейчас переадресация не настроена.'
          )}
        </p>

        <div className={st.fwdRadios}>
          {MTS_FORWARDING_TYPES.map(t => (
            <label key={t} className={st.fwdRadio}>
              <input
                type="radio"
                name="sub-fwd-type"
                checked={type === t}
                onChange={() => setType(t)}
                disabled={busy}
              />
              <span>{FORWARDING_TYPE_LABELS[t]}</span>
            </label>
          ))}
        </div>

        <div className={st.fwdFields}>
          <label className={st.fwdField}>
            <span className={st.fwdFieldLabel}>Номер для переадресации</span>
            <input
              className={st.fwdInput}
              type="tel"
              inputMode="tel"
              placeholder="+7 (___) ___-__-__"
              value={target}
              autoFocus
              onChange={e => setTarget(e.target.value)}
              onBlur={() => setTarget(prev => fmtPhone(prev.replace(/\D/g, '')))}
              disabled={busy}
            />
          </label>

          {type === 'CFNRY' && (
            <label className={st.fwdField}>
              <span className={st.fwdFieldLabel}>Ждать ответа</span>
              <select
                className={st.fwdInput}
                value={timer}
                onChange={e => setTimer(Number(e.target.value))}
                disabled={busy}
              >
                {TIMER_OPTIONS.map(s => <option key={s} value={s}>{s} сек</option>)}
              </select>
            </label>
          )}
        </div>

        <p className={styles.hint}>
          Переадресованные звонки тарифицируются как исходящие с номера сотрудника — по тарифу компании.
        </p>

        <div className={st.fwdActions}>
          {rule && (
            <button className={st.itemBtn} onClick={() => { void onDelete(); }} disabled={busy}>
              Отключить
            </button>
          )}
          <button
            className={st.fwdPrimary}
            onClick={() => { void onSave(); }}
            disabled={busy || targetDigits.length < 10}
          >
            {busy ? 'Применяется…' : rule ? 'Сохранить' : 'Включить'}
          </button>
        </div>
      </div>
    </div>
  );
};
