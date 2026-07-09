import { type FC, useState } from 'react';
import { useOverlayDismiss } from '../../../hooks/useOverlayDismiss';
import { useSetMtsBusinessNumberMap } from '../../../hooks/useMtsBusinessData';
import { EmployeeFioPicker } from '../../mts/EmployeeFioPicker';
import { errText, fmtPhone } from '../mtsBusinessFormat';
import type { IMtsAutoLinkConflict } from '../../../services/mtsBusinessService';
import st from './Subscribers.module.css';
import styles from '../MtsBusinessPage.module.css';

type Msg = { ok: boolean; text: string } | null;

const REASON_LABELS: Record<IMtsAutoLinkConflict['reason'], string> = {
  no_match: 'нет сотрудника ФОТ с таким ФИО',
  ambiguous: 'несколько однофамильцев',
};

/**
 * Модалка ручного разрешения конфликтов автосвязи: номера, чьё ФИО из МТС не
 * дало однозначного сотрудника ФОТ (0 совпадений или несколько однофамильцев).
 * Заведомо неверная привязка уже снята на бэкенде — здесь админ выбирает
 * правильного сотрудника (или подтверждает кандидата-однофамильца). После
 * привязки строка исчезает; пустой список закрывает модалку.
 */
export const AutoLinkConflictsModal: FC<{
  conflicts: IMtsAutoLinkConflict[];
  onClose: () => void;
}> = ({ conflicts, onClose }) => {
  const overlay = useOverlayDismiss(onClose);
  const setMap = useSetMtsBusinessNumberMap();
  const [items, setItems] = useState<IMtsAutoLinkConflict[]>(conflicts);
  const [msg, setMsg] = useState<Msg>(null);
  const [busyMsisdn, setBusyMsisdn] = useState<string | null>(null);

  const resolve = async (msisdn: string, employeeId: number): Promise<void> => {
    setMsg(null);
    setBusyMsisdn(msisdn);
    try {
      await setMap.mutateAsync({ msisdn, employeeId });
      const rest = items.filter(c => c.msisdn !== msisdn);
      setItems(rest);
      setMsg({ ok: true, text: 'Привязка сохранена' });
      if (rest.length === 0) onClose();
    } catch (e) {
      setMsg({ ok: false, text: errText(e, 'Ошибка привязки (возможно нужен 2FA)') });
    } finally {
      setBusyMsisdn(null);
    }
  };

  return (
    <div className={st.connectOverlay} {...overlay}>
      <div className={st.conflictModal}>
        <div className={st.drawerHeader}>
          <div>
            <h3 className={st.drawerTitle}>Конфликты автосвязи ({items.length})</h3>
            <p className={st.conflictHint}>
              Для этих номеров ФИО из МТС не совпало однозначно с сотрудником ФОТ. Неверные привязки
              сняты — выберите правильного сотрудника вручную.
            </p>
          </div>
          <button className={st.drawerClose} onClick={onClose} aria-label="Закрыть">×</button>
        </div>

        {msg && <p className={msg.ok ? styles.ok : styles.err}>{msg.text}</p>}

        <ul className={st.conflictList}>
          {items.map(c => {
            const busy = busyMsisdn === c.msisdn || setMap.isPending;
            return (
              <li key={c.msisdn} className={st.conflictRow}>
                <div className={st.conflictHead}>
                  <span className={st.conflictFio}>{c.mtsFio}</span>
                  <span className={st.conflictReason}>{REASON_LABELS[c.reason]}</span>
                </div>
                <div className={st.conflictMeta}>
                  {fmtPhone(c.msisdn)}
                  {c.currentEmployeeName ? ` · снята привязка: ${c.currentEmployeeName}` : ''}
                </div>
                <div className={st.conflictActions}>
                  {c.candidates.map(cand => (
                    <button
                      key={cand.id}
                      className={st.conflictCandidate}
                      disabled={busy}
                      onClick={() => { void resolve(c.msisdn, cand.id); }}
                      title="Привязать этого однофамильца"
                    >
                      {cand.fullName}{cand.tabNumber ? ` (таб. ${cand.tabNumber})` : ''}
                    </button>
                  ))}
                  <EmployeeFioPicker
                    disabled={busy}
                    placeholder="Привязать по ФИО…"
                    onSelect={id => { void resolve(c.msisdn, id); }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
};
