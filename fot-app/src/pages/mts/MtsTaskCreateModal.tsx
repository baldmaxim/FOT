import { type FC, useMemo, useState } from 'react';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import { mtsService, type IMtsSubscriber } from '../../services/mtsService';
import { ApiError } from '../../api/client';
import styles from './MtsPage.module.css';

interface IProps {
  subscribers: IMtsSubscriber[];
  defaultSubscriber?: IMtsSubscriber | null;
  onClose: () => void;
  onCreated: () => void;
}

const localIso = (d: Date): string => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export const MtsTaskCreateModal: FC<IProps> = ({ subscribers, defaultSubscriber, onClose, onCreated }) => {
  const dismiss = useOverlayDismiss(onClose);
  const defaultStart = useMemo(() => localIso(new Date()), []);

  const [title, setTitle] = useState('');
  const [startDate, setStartDate] = useState(defaultStart);
  const [deadline, setDeadline] = useState('');
  const [description, setDescription] = useState('');
  const [address, setAddress] = useState('');
  const [subscriberId, setSubscriberId] = useState<string>(
    defaultSubscriber ? String(defaultSubscriber.subscriberID) : '',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!title.trim() || !startDate) {
      setError('Укажите title и startDate');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await mtsService.createTask({
        title: title.trim(),
        startDate: new Date(startDate).toISOString(),
        deadline: deadline ? new Date(deadline).toISOString() : null,
        description: description.trim() || null,
        address: address.trim() || null,
        subscriberID: subscriberId ? Number(subscriberId) : null,
      });
      onCreated();
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не удалось создать задачу');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.overlay} {...dismiss}>
      <div className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="mts-task-title">
        <h3 id="mts-task-title" className={styles.modalTitle}>Создать задачу МТС</h3>

        <div className={styles.field}>
          <label className={styles.label}>Название (обязательно)</label>
          <input
            className={styles.input}
            type="text"
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="Доставить документы клиенту"
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label}>Начало (обязательно)</label>
          <input
            className={styles.input}
            type="datetime-local"
            value={startDate}
            onChange={e => setStartDate(e.target.value)}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label}>Дедлайн</label>
          <input
            className={styles.input}
            type="datetime-local"
            value={deadline}
            onChange={e => setDeadline(e.target.value)}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label}>Абонент (назначить)</label>
          <select
            className={styles.input}
            value={subscriberId}
            onChange={e => setSubscriberId(e.target.value)}
          >
            <option value="">— не назначать —</option>
            {subscribers.map(s => (
              <option key={s.subscriberID} value={s.subscriberID}>
                {s.name || `#${s.subscriberID}`} {s.phone ? `(${s.phone})` : ''}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.field}>
          <label className={styles.label}>Адрес</label>
          <input
            className={styles.input}
            type="text"
            value={address}
            onChange={e => setAddress(e.target.value)}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label}>Описание</label>
          <textarea
            className={styles.input}
            rows={3}
            value={description}
            onChange={e => setDescription(e.target.value)}
          />
        </div>

        {error && <p className={styles.err}>{error}</p>}

        <div className={styles.actions}>
          <button className={styles.btnSecondary} onClick={onClose} disabled={busy}>
            Отмена
          </button>
          <button className={styles.btn} onClick={submit} disabled={busy}>
            {busy ? 'Создаю…' : 'Создать в МТС'}
          </button>
        </div>
      </div>
    </div>
  );
};
