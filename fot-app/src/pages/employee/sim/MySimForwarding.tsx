import { type FC, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../../contexts/AuthContext';
import { useToast } from '../../../contexts/ToastContext';
import { useDeleteForwarding, useMyForwarding, useSetForwarding } from '../../../hooks/useMySim';
import { mySimService, type ForwardingType, type IForwardingRule } from '../../../services/mySimService';
import { ApiError } from '../../../api/client';
import { fmtLast, fmtPhone } from '../../mts-business/mtsBusinessFormat';
import styles from '../MySimPage.module.css';

const TYPE_LABELS: Record<ForwardingType, string> = {
  CFU: 'Переадресовывать всегда',
  CFNRY: 'Если не отвечаю',
  CFNRC: 'Если недоступен',
};

const TYPES: ForwardingType[] = ['CFU', 'CFNRY', 'CFNRC'];
const DEFAULT_TIMER = 20;
const POLL_MS = 5000;
const POLL_LIMIT = 24; // ~2 минуты

const isSupported = (t: string | null): t is ForwardingType => TYPES.includes(t as ForwardingType);

/** Активное правило = первое с поддерживаемым типом и указанным номером назначения. */
const pickRule = (rules: IForwardingRule[]): IForwardingRule | null =>
  rules.find(r => isSupported(r.forwardingType) && Boolean(r.forwardingAddress)) ?? null;

interface IProps {
  msisdn: string;
}

/**
 * Переадресация своего номера: показывает текущее правило (из ночного снапшота
 * МТС) и — при праве edit на /employee/sim — позволяет включить, изменить или
 * снять его. Заявка в МТС асинхронная: после отправки поллим статус по eventId,
 * пока не «completed», и только тогда обновляем правило.
 */
export const MySimForwarding: FC<IProps> = ({ msisdn }) => {
  const { canEditPage } = useAuth();
  const toast = useToast();
  const canEdit = canEditPage('/employee/sim');

  const { data, isLoading, refetch } = useMyForwarding();
  const setMutation = useSetForwarding();
  const deleteMutation = useDeleteForwarding();

  const entry = useMemo(() => data?.find(n => n.msisdn === msisdn) ?? null, [data, msisdn]);
  const rule = useMemo(() => pickRule(entry?.rules ?? []), [entry]);

  const [type, setType] = useState<ForwardingType>('CFU');
  const [target, setTarget] = useState('');
  const [timer, setTimer] = useState(DEFAULT_TIMER);
  const [pendingEventId, setPendingEventId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  // Форма стартует с текущего правила номера (и сбрасывается при смене номера).
  useEffect(() => {
    const current = pickRule(entry?.rules ?? []);
    setType(isSupported(current?.forwardingType ?? null) ? (current!.forwardingType as ForwardingType) : 'CFU');
    setTarget(current?.forwardingAddress ? fmtPhone(current.forwardingAddress) : '');
    setTimer(current?.noReplyTimer ?? DEFAULT_TIMER);
    setEditing(false);
  }, [entry, msisdn]);

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

  const handleSave = async (): Promise<void> => {
    try {
      const eventId = await setMutation.mutateAsync({
        msisdn,
        type,
        target: target.replace(/\D/g, ''),
        timer: type === 'CFNRY' ? timer : undefined,
      });
      setPendingEventId(eventId);
      setEditing(false);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Не удалось включить переадресацию');
    }
  };

  const handleDelete = async (): Promise<void> => {
    if (!rule || !isSupported(rule.forwardingType)) return;
    try {
      const eventId = await deleteMutation.mutateAsync({ msisdn, type: rule.forwardingType });
      setPendingEventId(eventId);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Не удалось отключить переадресацию');
    }
  };

  if (isLoading) {
    return (
      <div className={styles.card}>
        <h3 className={styles.usageTitle}>Переадресация</h3>
        <p className={styles.hint}>Загрузка…</p>
      </div>
    );
  }

  return (
    <div className={styles.card}>
      <div className={styles.usageHead}>
        <h3 className={styles.usageTitle}>Переадресация звонков</h3>
        {entry?.capturedAt && <span className={styles.updatedAt}>обновлено {fmtLast(entry.capturedAt)}</span>}
      </div>

      <div className={styles.fwdState} data-on={rule ? 'yes' : 'no'}>
        {pendingEventId ? (
          <span>Заявка отправлена в МТС, применяется…</span>
        ) : rule ? (
          <span>
            <strong>{TYPE_LABELS[rule.forwardingType as ForwardingType]}</strong> на{' '}
            <strong>{fmtPhone(rule.forwardingAddress)}</strong>
            {rule.forwardingType === 'CFNRY' && rule.noReplyTimer ? ` (через ${rule.noReplyTimer} сек)` : ''}
          </span>
        ) : (
          <span>Переадресация выключена — звонки приходят только на эту SIM.</span>
        )}
      </div>

      {!canEdit && (
        <p className={styles.hint}>Изменение переадресации недоступно. Обратитесь к администратору.</p>
      )}

      {canEdit && !editing && (
        <div className={styles.fwdActions}>
          <button className={styles.btnPrimary} onClick={() => setEditing(true)} disabled={busy}>
            {rule ? 'Изменить' : 'Включить переадресацию'}
          </button>
          {rule && (
            <button className={styles.btnGhost} onClick={handleDelete} disabled={busy}>
              Отключить
            </button>
          )}
        </div>
      )}

      {canEdit && editing && (
        <div className={styles.fwdForm}>
          <div className={styles.fwdRadios}>
            {TYPES.map(t => (
              <label key={t} className={styles.fwdRadio}>
                <input
                  type="radio"
                  name="fwd-type"
                  checked={type === t}
                  onChange={() => setType(t)}
                  disabled={busy}
                />
                <span>{TYPE_LABELS[t]}</span>
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

          <div className={styles.fwdActions}>
            <button className={styles.btnPrimary} onClick={handleSave} disabled={busy || target.replace(/\D/g, '').length < 10}>
              {busy ? 'Применяется…' : 'Сохранить'}
            </button>
            <button className={styles.btnGhost} onClick={() => setEditing(false)} disabled={busy}>
              Отмена
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
