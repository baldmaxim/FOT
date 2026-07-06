import { type FC } from 'react';
import { useMtsBusinessPdRequests, useRefreshMtsBusinessPdRequestStatus } from '../../../hooks/useMtsBusinessPersonalData';
import { fmtLast, PD_OPERATION_LABELS } from '../mtsBusinessFormat';
import styles from '../MtsBusinessPage.module.css';

const STATUS_BADGE: Record<string, { cls: string; label: string }> = {
  completed: { cls: styles.badgeOk, label: 'выполнено' },
  in_progress: { cls: styles.badgeWait, label: 'в обработке' },
  faulted: { cls: styles.badgeErr, label: 'ошибка' },
  unknown: { cls: styles.badgeMuted, label: '—' },
};

/**
 * Журнал заявок на внесение/удаление персональных данных. Статус меняется
 * асинхронно (SMS пользователю → подтверждение через Госуслуги): пока есть
 * незавершённые, список сам обновляется каждые 15 секунд.
 */
export const PersonalDataRequestsCard: FC = () => {
  const requests = useMtsBusinessPdRequests(true);
  const refreshStatus = useRefreshMtsBusinessPdRequestStatus();
  const rows = requests.data ?? [];

  return (
    <>
      {requests.isLoading && <p className={styles.hint}>Загрузка…</p>}
      {!requests.isLoading && rows.length === 0 && (
        <p className={styles.hint}>Заявок пока нет. Внести данные можно из карточки номера или из таблицы «Номера и привязки».</p>
      )}
      {rows.length > 0 && (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead><tr><th>Номер</th><th>Операция</th><th>Статус</th><th>Отправлено</th><th>Проверено</th><th></th></tr></thead>
            <tbody>
              {rows.map(r => {
                const badge = STATUS_BADGE[r.status] ?? STATUS_BADGE.unknown;
                const pending = r.status === 'in_progress' || r.status === 'unknown';
                return (
                  <tr key={r.messageId}>
                    <td>{r.msisdn ?? '—'}</td>
                    <td>{PD_OPERATION_LABELS[r.operation] ?? r.operation}</td>
                    <td>
                      <span className={`${styles.badge} ${badge.cls}`} title={r.statusDetail ?? undefined}>{badge.label}</span>
                    </td>
                    <td>{fmtLast(r.requestedAt)}</td>
                    <td>{fmtLast(r.checkedAt)}</td>
                    <td>
                      {pending && (
                        <button
                          className={styles.btnSecondary}
                          disabled={refreshStatus.isPending}
                          onClick={() => { void refreshStatus.mutateAsync(r.messageId).catch(() => undefined); }}
                        >
                          Проверить
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
};
