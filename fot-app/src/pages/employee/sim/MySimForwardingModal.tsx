import { type FC, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../../../contexts/AuthContext';
import { useToast } from '../../../contexts/ToastContext';
import { useOverlayDismiss } from '../../../hooks/useOverlayDismiss';
import { useDeleteForwarding, useForwardingOperation, useMyForwarding, useSetForwarding } from '../../../hooks/useMySim';
import { mySimService, type ForwardingType, type IForwardingOperation } from '../../../services/mySimService';
import type { IForwardingResult } from '../../../services/mtsBusinessSubscriberService';
import { fmtPhone, mtsErrText } from '../../mts-business/mtsBusinessFormat';
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

/** Текст в блоке состояния, пока операция включения не завершена. */
const operationStateText = (op: IForwardingOperation): string =>
  op.state === 'unconfirmed'
    ? 'МТС пока не подтвердил результат. Повторять не нужно — проверим автоматически.'
    : `Подключаем переадресацию на ••${op.targetTail}. Это займёт несколько минут.`;

/**
 * Модалка управления переадресацией своего номера: текущее правило (из ночного
 * снапшота МТС) + форма включения/изменения и кнопка отключения.
 * Включение — серверная операция: при необходимости портал сам подключает
 * услугу «Переадресация вызова», ставит правило и подтверждает его. Пока она
 * идёт, форма заперта (повторная отправка недопустима), статус опрашивается;
 * окно можно закрыть — операция доводится на сервере.
 * Отключение: queued — поллим статус по eventId; applied — сразу перечитываем;
 * unknown — форму запираем.
 * Без права edit на /employee/sim — только просмотр текущего правила.
 */
export const MySimForwardingModal: FC<IProps> = ({ msisdn, onClose }) => {
  const { canEditPage } = useAuth();
  const toast = useToast();
  const canEdit = canEditPage('/employee/sim');

  const { data, isLoading, refetch } = useMyForwarding();
  const { data: operation } = useForwardingOperation(msisdn);
  const setMutation = useSetForwarding();
  const deleteMutation = useDeleteForwarding();
  const activeOperation = operation && !operation.final ? operation : null;

  const entry = useMemo(() => data?.find(n => n.msisdn === msisdn) ?? null, [data, msisdn]);
  const rule = useMemo(() => pickForwardingRule(entry?.rules ?? []), [entry]);

  const [type, setType] = useState<ForwardingType>('CFU');
  const [target, setTarget] = useState('');
  const [timer, setTimer] = useState(DEFAULT_NO_REPLY_TIMER);
  const [pendingEventId, setPendingEventId] = useState<string | null>(null);
  // Исход в МТС не подтверждён — кнопки запираем, повтор мутации недопустим.
  const [locked, setLocked] = useState(false);

  const overlayHandlers = useOverlayDismiss(onClose);

  // Форма стартует с текущего правила номера; пока идёт операция — с её параметрами
  // с сервера (номер назначения известен только хвостом).
  useEffect(() => {
    if (activeOperation) {
      setType(activeOperation.type);
      setTarget(`••${activeOperation.targetTail}`);
      setTimer(activeOperation.timer ?? DEFAULT_NO_REPLY_TIMER);
      return;
    }
    const current = pickForwardingRule(entry?.rules ?? []);
    setType(isForwardingType(current?.forwardingType) ? current.forwardingType : 'CFU');
    setTarget(current?.forwardingAddress ? fmtPhone(current.forwardingAddress) : '');
    setTimer(current?.noReplyTimer ?? DEFAULT_NO_REPLY_TIMER);
  }, [entry, activeOperation]);

  // Итог операции, которую эта модалка видела незавершённой: успех — перечитать
  // правило и сообщить; отказ — показать причину. Старый итог при открытии не озвучиваем.
  const seenActiveRef = useRef<string | null>(null);
  useEffect(() => {
    if (!operation) return;
    if (!operation.final) {
      seenActiveRef.current = operation.id;
      return;
    }
    if (seenActiveRef.current !== operation.id) return;
    seenActiveRef.current = null;
    if (operation.state === 'done') {
      void refetch();
      toast.success('Переадресация включена');
    } else {
      toast.error(operation.errorMessage || 'Не удалось включить переадресацию');
    }
  }, [operation, refetch, toast]);

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

  const busy = Boolean(pendingEventId) || Boolean(activeOperation) || locked || setMutation.isPending || deleteMutation.isPending;
  const targetDigits = target.replace(/\D/g, '');

  /** Общая развилка исходов: заявка / уже применено / не подтверждено. */
  const handleResult = async (r: IForwardingResult, appliedText: string): Promise<void> => {
    if (r.outcome === 'queued' && r.eventId) {
      setPendingEventId(r.eventId);
      return;
    }
    if (r.outcome === 'applied') {
      await refetch();
      toast.success(r.tracking ? appliedText : `${appliedText}. Состояние обновится позже`);
      return;
    }
    setLocked(true);
    toast.showToast('info', 'МТС принял запрос, но результат пока не подтверждён. Не повторяйте — проверьте состояние позже.');
  };

  const handleSave = async (): Promise<void> => {
    try {
      const result = await setMutation.mutateAsync({
        msisdn,
        type,
        target: targetDigits,
        timer: type === 'CFNRY' ? timer : undefined,
      });
      // operation_pending — операция на сервере, итог озвучит эффект по её статусу.
      if (result.outcome === 'applied') {
        await refetch();
        toast.success('Переадресация включена');
      }
    } catch (error) {
      toast.error(mtsErrText(error, 'Не удалось включить переадресацию'));
    }
  };

  const handleDelete = async (): Promise<void> => {
    if (!rule || !isForwardingType(rule.forwardingType)) return;
    try {
      const result = await deleteMutation.mutateAsync({ msisdn, type: rule.forwardingType });
      await handleResult(result, 'Переадресация отключена');
    } catch (error) {
      toast.error(mtsErrText(error, 'Не удалось отключить переадресацию'));
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
                {activeOperation ? (
                  <span>{operationStateText(activeOperation)}</span>
                ) : pendingEventId ? (
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
