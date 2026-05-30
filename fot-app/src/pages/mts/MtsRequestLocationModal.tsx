import { type FC, useState } from 'react';
import { mtsService, type IMtsSubscriber } from '../../services/mtsService';
import { ApiError } from '../../api/client';
import { ModalShell } from '../../components/ui/ModalShell';
import styles from './MtsPage.module.css';

interface IProps {
  subscriber: IMtsSubscriber;
  onClose: () => void;
  onConfirmed: () => void;
}

export const MtsRequestLocationModal: FC<IProps> = ({ subscriber, onClose, onConfirmed }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await mtsService.requestLocation(subscriber.subscriberID);
      onConfirmed();
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не удалось отправить запрос');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell onClose={onClose} overlayClassName={styles.overlay} containerClassName={styles.modal} aria-labelledby="mts-paid-title">
      {({ requestClose }) => (
        <>
          <h3 id="mts-paid-title" className={styles.modalTitle}>
            Запросить актуальное положение
          </h3>

          <div className={styles.warningBox}>
            <strong>⚠ Это ПЛАТНЫЙ запрос МТС.</strong>
            <p className={styles.warningText}>
              МТС определит текущее положение абонента (LBS-триангуляция + GPS, если у абонента
              установлено приложение «МТС Координатор»). Стоимость одного запроса — по тарифу
              M-Poisk, обычно <b>3–5 ₽</b>. Действие записывается в аудит-лог.
            </p>
            <p className={styles.warningText}>
              Альтернатива бесплатно: подождать следующего часового обновления — фоновый поллер
              подтянет последнюю известную позицию, когда телефон абонента активен в сети.
            </p>
          </div>

          <div className={styles.field}>
            <span className={styles.label}>Абонент</span>
            <div>{subscriber.name || `#${subscriber.subscriberID}`}</div>
            {subscriber.phone && <div className={styles.hint}>{subscriber.phone}</div>}
          </div>

          {error && <p className={styles.err}>{error}</p>}

          <div className={styles.actions}>
            <button className={styles.btnSecondary} onClick={requestClose} disabled={busy}>
              Отмена
            </button>
            <button className={styles.btnDanger} onClick={confirm} disabled={busy}>
              {busy ? 'Запрос…' : 'Да, запросить (платно)'}
            </button>
          </div>
        </>
      )}
    </ModalShell>
  );
};
