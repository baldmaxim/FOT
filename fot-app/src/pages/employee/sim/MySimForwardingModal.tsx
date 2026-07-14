import { type FC, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../../contexts/AuthContext';
import { useToast } from '../../../contexts/ToastContext';
import { useOverlayDismiss } from '../../../hooks/useOverlayDismiss';
import { useDeleteForwarding, useMyForwarding, useSetForwarding } from '../../../hooks/useMySim';
import { mySimService, type ForwardingType } from '../../../services/mySimService';
import { ApiError } from '../../../api/client';
import { fmtPhone } from '../../mts-business/mtsBusinessFormat';
import {
  DEFAULT_NO_REPLY_TIMER,
  FORWARDING_TYPES,
  FORWARDING_TYPE_LABELS,
  isForwardingType,
  pickForwardingRule,
} from './forwarding';
import styles from '../MySimPage.module.css';

const POLL_MS = 5000;
const POLL_LIMIT = 24; // ~2 минуты

interface IProps {
  msisdn: string;
  onClose: () => void;
}

/**
 * Модалка управления переадресацией своего номера: текущее правило (из ночного
 * снапшота МТС) + форма включения/изменения и кнопка отключения. Заявка в МТС
 * асинхронная — после отправки поллим статус по eventId до «completed».
 * Без права edit на /employee/sim — только просмотр текущего правила.
 */
export const MySimForwardingModal: FC<IProps> = ({ msisdn, onClose }) => {
  const { canEditPage } = useAuth();
  const toast = useToast();
  const canEdit = canEditPage('/employee/sim');

  const { data, isLoading, refetch } = useMyForwarding();
  const setMutation = useSetForwarding();
  const deleteMutation = useDeleteForwarding();

  const entry = useMemo(() => data?.find(n => n.msisdn === msisdn) ?? null, [data, msisdn]);
  const rule = useMemo(() => pickForwardingRule(entry?.rules ?? []), [entry]);

  const [type, setType] = useState<ForwardingType>('CFU');
  const [target, setTarget] = useState('');
  const [timer, setTimer] = useState(DEFAULT_NO_REPLY_TIMER);
  const [pendingEventId, setPendingEventId] = useState<string | null>(null);

  const overlayHandlers = useOverlayDismiss(onClose);

  // Форма стартует с текущего правила номера.
  useEffect(() => {
    const current = pickForwardingRule(entry?.rules ?? []);
    setType(isForwardingType(current?.forwardingType) ? current.forwardingType : 'CFU');
    setTarget(current?.forwardingAddress ? fmtPhone(current.forwardingAddress) : '');
    setTimer(current?.noReplyTimer ?? DEFAULT_NO_REPLY_TIMER);
  }, [entry]);

  // Поллинг статуса заявки: МТС применяет правило асинхронно.
  useEffect(() => {
    if (!pendingEventId) return;
    let attempts = 0;
    let stopped = false;

    const id = window.setInterval(() => {
      attempts++;
      void (async () => {
        try {
          const status = await mySimService.getForwardingStatus(pendingEventId);
          if (stopped) return;
          if (status === 'completed') {
            window.clearInterval(id);
            setPendingEventId(null);
            await refetch();
            toast.success('Переадресация обновлена');
          } else if (status === 'faulted') {
            window.clearInterval(id);
            setPendingEventId(null);
            toast.error('МТС отклонил заявку на переадресацию');
          } else if (attempts >= POLL_LIMIT) {
            window.clearInterval(id);
            setPendingEventId(null);
            toast.showToast('info', 'Заявка отправлена, МТС применит её в течение нескольких минут');
          }
        } catch {
          window.clearInterval(id);
          setPendingEventId(null);
        }
      })();
    }, POLL_MS);

    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [pendingEventId, refetch, toast]);

  const busy = Boolean(pendingEventId) || setMutation.isPending || deleteMutation.isPending;
  const targetDigits = target.replace(/\D/g, '');

  const handleSave = async (): Promise<void> => {
    try {
      const eventId = await setMutation.mutateAsync({
        msisdn,
        type,
        target: targetDigits,
        timer: type === 'CFNRY' ? timer : undefined,
      });
      setPendingEventId(eventId);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Не удалось включить переадресацию');
    }
  };

  const handleDelete = async (): Promise<void> => {
    if (!rule || !isForwardingType(rule.forwardingType)) return;
    try {
      const eventId = await deleteMutation.mutateAsync({ msisdn, type: rule.forwardingType });
      setPendingEventId(eventId);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Не удалось отключить переадресацию');
    }
  };

  return (
    <div className={styles.overlay} {...overlayHandlers}>
      <div className={styles.modal} role="dialog" aria-modal="true" aria-label="Переадресация звонков">
        <div className={styles.modalHead}>
          <h3 className={styles.modalTitle}>Переадресация звонков</h3>
          <button className={styles.modalClose} onClick={onClose} aria-label="Закрыть">×</button>
        </div>

        <div className={styles.modalBody}>
          {isLoading ? (
            <p className={styles.hint}>Загрузка…</p>
          ) : (
            <>
              <div className={styles.fwdState} data-on={rule ? 'yes' : 'no'}>
                {pendingEventId ? (
                  <span>Заявка отправлена в МТС, применяется…</span>
                ) : rule ? (
                  <span>
                    <strong>{FORWARDING_TYPE_LABELS[rule.forwardingType as ForwardingType]}</strong> на{' '}
                    <strong>{fmtPhone(rule.forwardingAddress)}</strong>
                    {rule.forwardingType === 'CFNRY' && rule.noReplyTimer ? ` (через ${rule.noReplyTimer} сек)` : ''}
                  </span>
                ) : (
                  <span>Переадресация выключена — звонки приходят только на эту SIM.</span>
                )}
              </div>

              {!canEdit ? (
                <p className={styles.hint}>Изменение переадресации недоступно. Обратитесь к администратору.</p>
              ) : (
                <div className={styles.fwdForm}>
                  <div className={styles.fwdRadios}>
                    {FORWARDING_TYPES.map(t => (
                      <label key={t} className={styles.fwdRadio}>
                        <input
                          type="radio"
                          name="fwd-type"
                          checked={type === t}
                          onChange={() => setType(t)}
                          disabled={busy}
                        />
                        <span>{FORWARDING_TYPE_LABELS[t]}</span>
                      </label>
                    ))}
                  </div>

                  <div className={styles.fwdFields}>
                    <label className={styles.fwdField}>
                      <span className={styles.kvLabel}>Номер для переадресации</span>
                      <input
                        className={styles.input}
                        type="tel"
                        inputMode="tel"
                        placeholder="+7 (___) ___-__-__"
                        value={target}
                        onChange={e => setTarget(e.target.value)}
                        onBlur={() => setTarget(prev => fmtPhone(prev.replace(/\D/g, '')))}
                        disabled={busy}
                      />
                    </label>

                    {type === 'CFNRY' && (
                      <label className={styles.fwdField}>
                        <span className={styles.kvLabel}>Ждать ответа</span>
                        <select
                          className={styles.select}
                          value={timer}
                          onChange={e => setTimer(Number(e.target.value))}
                          disabled={busy}
                        >
                          {[5, 10, 15, 20, 25, 30].map(s => (
                            <option key={s} value={s}>{s} сек</option>
                          ))}
                        </select>
                      </label>
                    )}
                  </div>

                  <p className={styles.fwdWarn}>
                    Переадресованные звонки тарифицируются как исходящие с вашего номера — по тарифу компании.
                  </p>
                </div>
              )}
            </>
          )}
        </div>

        {canEdit && !isLoading && (
          <div className={styles.modalFoot}>
            {rule && (
              <button className={styles.btnGhost} onClick={handleDelete} disabled={busy}>
                Отключить
              </button>
            )}
            <button
              className={styles.btnPrimary}
              onClick={handleSave}
              disabled={busy || targetDigits.length < 10}
            >
              {busy ? 'Применяется…' : rule ? 'Сохранить' : 'Включить'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
