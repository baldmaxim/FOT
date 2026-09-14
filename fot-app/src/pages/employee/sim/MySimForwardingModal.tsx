import { type FC, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../../../contexts/AuthContext';
import { useToast } from '../../../contexts/ToastContext';
import { useOverlayDismiss } from '../../../hooks/useOverlayDismiss';
import { useDeleteForwarding, useForwardingOperation, useMyForwarding, useSetForwarding } from '../../../hooks/useMySim';
import type { ForwardingType, IForwardingOperation } from '../../../services/mySimService';
import { fmtPhone, mtsErrText } from '../../mts-business/mtsBusinessFormat';
import {
  DEFAULT_NO_REPLY_TIMER,
  FORWARDING_TYPES,
  FORWARDING_TYPE_LABELS,
  isForwardingType,
  pickForwardingRule,
} from './forwarding';
import styles from '../MySimPage.module.css';

interface IProps {
  msisdn: string;
  onClose: () => void;
}

/** Текст в блоке состояния, пока операция не завершена. */
const operationStateText = (op: IForwardingOperation): string => {
  if (op.state === 'unconfirmed') return 'МТС пока не подтвердил результат. Повторять не нужно — проверим автоматически.';
  if (op.kind === 'remove') return 'Отключаем переадресацию. Это займёт несколько минут.';
  return `Подключаем переадресацию на ••${op.targetTail ?? ''}. Это займёт несколько минут.`;
};

/** Стартовые значения формы из текущего правила номера. */
const formFromRule = (rule: ReturnType<typeof pickForwardingRule>): { type: ForwardingType; target: string; timer: number } => ({
  type: isForwardingType(rule?.forwardingType) ? rule.forwardingType : 'CFU',
  target: rule?.forwardingAddress ? fmtPhone(rule.forwardingAddress) : '',
  timer: rule?.noReplyTimer ?? DEFAULT_NO_REPLY_TIMER,
});

const doneText = (op: Pick<IForwardingOperation, 'kind'>): string =>
  op.kind === 'remove' ? 'Переадресация отключена' : 'Переадресация включена';

/**
 * Модалка управления переадресацией своего номера: текущее правило (из снапшота
 * МТС) + форма включения/смены режима и кнопка отключения.
 * Любое изменение — серверная операция: портал при необходимости подключает услугу
 * «Переадресация вызова», снимает мешающие правила других типов, ставит выбранное
 * и подтверждает режим целиком. Пока операция идёт, форма заперта (повторная
 * отправка недопустима), статус опрашивается; окно можно закрыть.
 * Правила перечитываются при любом итоге — в том числе при частичном результате
 * (прежнее правило снято, новое МТС отклонил).
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

  const initial = useMemo(() => formFromRule(rule), [rule]);
  const [type, setType] = useState<ForwardingType>(initial.type);
  const [target, setTarget] = useState(initial.target);
  const [timer, setTimer] = useState(initial.timer);
  // Правило номера обновилось (снапшот перечитан) — форма стартует с него заново.
  // Подстройка состояния при рендере вместо эффекта (react.dev: «You might not need an effect»).
  const [formRule, setFormRule] = useState(rule);
  if (formRule !== rule) {
    setFormRule(rule);
    setType(initial.type);
    setTarget(initial.target);
    setTimer(initial.timer);
  }

  const overlayHandlers = useOverlayDismiss(onClose);

  // Пока идёт включение, форма показывает параметры операции с сервера (номер назначения — только хвостом).
  const activeSet = activeOperation?.kind === 'set' ? activeOperation : null;
  const shownType = activeSet ? activeSet.type : type;
  const shownTarget = activeSet ? `••${activeSet.targetTail ?? ''}` : target;
  const shownTimer = activeSet ? activeSet.timer ?? DEFAULT_NO_REPLY_TIMER : timer;

  // Итог операции, которую эта модалка видела незавершённой: правила перечитываем при
  // любом итоге; успех — сообщение, отказ — причина. Старый итог при открытии не озвучиваем.
  const seenActiveRef = useRef<string | null>(null);
  useEffect(() => {
    if (!operation) return;
    if (!operation.final) {
      seenActiveRef.current = operation.id;
      return;
    }
    if (seenActiveRef.current !== operation.id) return;
    seenActiveRef.current = null;
    void refetch();
    if (operation.state === 'done') toast.success(doneText(operation));
    else toast.error(operation.errorMessage || 'Не удалось изменить переадресацию');
  }, [operation, refetch, toast]);

  const busy = Boolean(activeOperation) || setMutation.isPending || deleteMutation.isPending;
  const targetDigits = target.replace(/\D/g, '');

  const handleSave = async (): Promise<void> => {
    try {
      const result = await setMutation.mutateAsync({
        msisdn,
        type,
        target: targetDigits,
        timer: type === 'CFNRY' ? timer : undefined,
      });
      // operation_pending — операция на сервере, итог озвучит эффект по её статусу.
      if (result.outcome === 'applied') toast.success(doneText(result.operation));
    } catch (error) {
      // Правила и операцию перечитает onSettled хука — в т.ч. после частичного результата.
      toast.error(mtsErrText(error, 'Не удалось включить переадресацию'));
    }
  };

  const handleDelete = async (): Promise<void> => {
    if (!rule || !isForwardingType(rule.forwardingType)) return;
    try {
      const result = await deleteMutation.mutateAsync({ msisdn, type: rule.forwardingType });
      if (result.outcome === 'applied') toast.success(doneText(result.operation));
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
                          checked={shownType === t}
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
                        value={shownTarget}
                        onChange={e => setTarget(e.target.value)}
                        onBlur={() => setTarget(prev => fmtPhone(prev.replace(/\D/g, '')))}
                        disabled={busy}
                      />
                    </label>

                    {shownType === 'CFNRY' && (
                      <label className={styles.fwdField}>
                        <span className={styles.kvLabel}>Ждать ответа</span>
                        <select
                          className={styles.select}
                          value={shownTimer}
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
