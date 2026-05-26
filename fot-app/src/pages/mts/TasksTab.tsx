import { type FC, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useMtsTasks,
  useMtsSubscribers,
  useMtsConnectionSettings,
  getMtsTasksQueryKey,
} from '../../hooks/useMtsData';
import { mtsService } from '../../services/mtsService';
import { MtsTaskCreateModal } from './MtsTaskCreateModal';
import styles from './MtsPage.module.css';

export const TasksTab: FC = () => {
  const queryClient = useQueryClient();
  const connQuery = useMtsConnectionSettings();
  const configured = Boolean(connQuery.data?.hasToken);

  const tasksQuery = useMtsTasks(configured);
  const subsQuery = useMtsSubscribers(configured);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);

  return (
    <section className={styles.card}>
      <div className={styles.tableHeader}>
        <h2 className={styles.cardTitle}>
          Задачи МТС {tasksQuery.data ? `(${tasksQuery.data.length})` : ''}
        </h2>
        <div className={styles.actions}>
          <button className={styles.btn} onClick={() => setOpen(true)} disabled={busy}>
            + Создать задачу
          </button>
        </div>
      </div>

      {status && <p className={status.ok ? styles.ok : styles.err}>{status.msg}</p>}
      {tasksQuery.isError && <p className={styles.err}>Не удалось загрузить задачи</p>}
      {tasksQuery.isLoading && <p className={styles.hint}>Загрузка…</p>}

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>МТС task ID</th>
              <th>Название</th>
              <th>Абонент</th>
              <th>Начало</th>
              <th>Дедлайн</th>
              <th>Статус</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(tasksQuery.data ?? []).map(t => (
              <tr key={t.id}>
                <td>{t.mtsTaskId ?? '—'}</td>
                <td>{t.title || '—'}</td>
                <td>{t.subscriberId ?? '—'}</td>
                <td>{new Date(t.startDate).toLocaleString('ru-RU')}</td>
                <td>{t.deadline ? new Date(t.deadline).toLocaleString('ru-RU') : '—'}</td>
                <td>{t.status || '—'}</td>
                <td>
                  {t.mtsTaskId != null && (
                    <button
                      className={styles.btnSm}
                      disabled={busy}
                      onClick={async () => {
                        try {
                          setBusy(true);
                          await mtsService.getTask(t.mtsTaskId as number);
                          await queryClient.invalidateQueries({ queryKey: getMtsTasksQueryKey() });
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      Обновить
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {tasksQuery.isSuccess && (tasksQuery.data?.length ?? 0) === 0 && (
              <tr>
                <td colSpan={7} className={styles.hint}>Нет задач</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {open && (
        <MtsTaskCreateModal
          subscribers={subsQuery.data ?? []}
          onClose={() => setOpen(false)}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: getMtsTasksQueryKey() });
            setStatus({ ok: true, msg: 'Задача создана.' });
          }}
        />
      )}
    </section>
  );
};
