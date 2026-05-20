import { type FC, useMemo, useState } from 'react';
import { useMtsHistory } from '../../hooks/useMtsData';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import type { IMtsSubscriber } from '../../services/mtsService';
import styles from './MtsPage.module.css';

interface IProps {
  subscriber: IMtsSubscriber;
  onClose: () => void;
}

// Локальный YYYY-MM-DDTHH:mm для <input type=datetime-local>
const localIso = (d: Date): string => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const initialRange = (): { from: string; to: string } => {
  const to = new Date();
  const from = new Date(to);
  from.setHours(0, 0, 0, 0);
  return { from: localIso(from), to: localIso(to) };
};

const fmt = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('ru-RU');
};

export const MtsHistoryModal: FC<IProps> = ({ subscriber, onClose }) => {
  const dismiss = useOverlayDismiss(onClose);
  const [{ from, to }, setRange] = useState(initialRange);
  const [submitted, setSubmitted] = useState({ from: '', to: '' });

  const toIso = useMemo(() => (submitted.to ? new Date(submitted.to).toISOString() : ''), [submitted.to]);
  const fromIso = useMemo(
    () => (submitted.from ? new Date(submitted.from).toISOString() : ''),
    [submitted.from],
  );

  const historyQuery = useMtsHistory(
    submitted.from ? subscriber.subscriberID : null,
    fromIso,
    toIso,
    Boolean(submitted.from && submitted.to),
  );

  return (
    <div className={styles.overlay} {...dismiss}>
      <div className={styles.modalWide} role="dialog" aria-modal="true" aria-labelledby="mts-history-title">
        <div className={styles.modalHeader}>
          <h3 id="mts-history-title" className={styles.modalTitle}>
            История перемещений — {subscriber.name || `#${subscriber.subscriberID}`}
          </h3>
          <button className={styles.btnSm} onClick={onClose}>
            Закрыть
          </button>
        </div>

        <p className={styles.hint}>
          Точки сохранены фоновым поллером (раз в час, бесплатно). Контент в БД — зашифрован
          (AES-256-GCM), здесь расшифровывается на лету. Любой просмотр истории записывается
          в аудит.
        </p>

        <div className={styles.rangeRow}>
          <label className={styles.label}>
            С
            <input
              className={styles.input}
              type="datetime-local"
              value={from}
              onChange={e => setRange(r => ({ ...r, from: e.target.value }))}
            />
          </label>
          <label className={styles.label}>
            По
            <input
              className={styles.input}
              type="datetime-local"
              value={to}
              onChange={e => setRange(r => ({ ...r, to: e.target.value }))}
            />
          </label>
          <button
            className={styles.btn}
            onClick={() => setSubmitted({ from, to })}
            disabled={!from || !to || historyQuery.isFetching}
          >
            {historyQuery.isFetching ? 'Загрузка…' : 'Показать'}
          </button>
        </div>

        {historyQuery.isError && <p className={styles.err}>Не удалось загрузить историю</p>}

        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Время</th>
                <th>Координаты</th>
                <th>Точность</th>
                <th>Адрес</th>
                <th>Источник</th>
              </tr>
            </thead>
            <tbody>
              {(historyQuery.data ?? []).map((p, i) => (
                <tr key={`${p.recordedAt}-${i}`}>
                  <td>{fmt(p.recordedAt)}</td>
                  <td>
                    {p.latitude != null && p.longitude != null ? (
                      <a
                        className={styles.link}
                        href={`https://yandex.ru/maps/?pt=${p.longitude},${p.latitude}&z=16&l=map`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {p.latitude.toFixed(5)}, {p.longitude.toFixed(5)}
                      </a>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>{p.accuracy != null ? `${p.accuracy} м` : '—'}</td>
                  <td>{p.address || '—'}</td>
                  <td>{p.source || '—'}</td>
                </tr>
              ))}
              {submitted.from && historyQuery.isSuccess && (historyQuery.data?.length ?? 0) === 0 && (
                <tr>
                  <td colSpan={5} className={styles.hint}>
                    Нет точек за выбранный период
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
