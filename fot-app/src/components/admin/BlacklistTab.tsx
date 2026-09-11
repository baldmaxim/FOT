import { useState } from 'react';
import type { FC } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { adminService, type IBlacklistRow } from '../../services/adminService';
import { ApiError } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { BlacklistAddModal } from './BlacklistAddModal';
import { BlacklistRemoveModal } from './BlacklistRemoveModal';
import styles from '../../pages/admin/Admin.module.css';

const errMsg = (e: unknown, fallback: string): string =>
  e instanceof ApiError ? e.message : fallback;

const formatDate = (iso: string | null): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('ru-RU');
};

/** Состояние блокировки пропуска: агрегат по целям записи. */
const sigurStatus = (row: IBlacklistRow): { text: string; className: string } => {
  if (row.removed_at) return { text: 'снята', className: styles.blacklistChipMuted };
  if (row.targets_total === 0) return { text: 'профилей нет', className: styles.blacklistChipMuted };
  if (row.targets_failed > 0) return { text: 'ошибка блокировки', className: styles.blacklistChipDanger };
  if (row.targets_pending > 0) return { text: 'блокируется…', className: styles.blacklistChipMuted };
  return { text: `заблокировано: ${row.targets_done}`, className: styles.blacklistChipOk };
};

export const BlacklistTab: FC = () => {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [includeRemoved, setIncludeRemoved] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<IBlacklistRow | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);

  const listQuery = useQuery<IBlacklistRow[]>({
    queryKey: ['admin-users', 'blacklist', includeRemoved],
    queryFn: ({ signal }) => adminService.getBlacklist(includeRemoved, signal),
    staleTime: 30_000,
  });

  const rows = listQuery.data || [];
  const failedCount = rows.filter(r => !r.removed_at && r.targets_failed > 0).length;

  const reload = async () => {
    await queryClient.invalidateQueries({ queryKey: ['admin-users', 'blacklist'] });
  };

  const handleRetry = async (row: IBlacklistRow) => {
    setRetryingId(row.id);
    try {
      await adminService.retryBlacklistSigur(row.id);
      toast.success('Блокировка отправлена повторно');
      await reload();
    } catch (e) {
      toast.error(errMsg(e, 'Не удалось повторить блокировку'));
    } finally {
      setRetryingId(null);
    }
  };

  return (
    <>
      <div className={styles.blacklistToolbar}>
        <label className={styles.blacklistToggle}>
          <input
            type="checkbox"
            checked={includeRemoved}
            onChange={e => setIncludeRemoved(e.target.checked)}
          />
          <span>Показывать снятые</span>
        </label>
        <button className={styles.primaryBtn} onClick={() => setAddOpen(true)}>
          Добавить
        </button>
      </div>

      {failedCount > 0 && (
        <div className={styles.error}>
          Не удалось заблокировать пропуск у {failedCount} записей — нажмите «Повторить» в строке.
        </div>
      )}

      {listQuery.isPending && rows.length === 0 && (
        <div className={styles.pendingEmpty}>Загрузка...</div>
      )}

      {!listQuery.isPending && rows.length === 0 && (
        <div className={styles.pendingEmpty}>Чёрный список пуст</div>
      )}

      {rows.length > 0 && (
        <div className={styles.blacklistList}>
          <div className={styles.blacklistHeader}>
            <span>ФИО</span>
            <span>СНИЛС</span>
            <span>Почта</span>
            <span>Кто внёс</span>
            <span>Комментарий</span>
            <span>Пропуск</span>
            <span />
          </div>

          {rows.map(row => {
            const status = sigurStatus(row);
            return (
              <div
                key={row.id}
                className={`${styles.blacklistRow} ${row.removed_at ? styles.blacklistRowRemoved : ''}`}
              >
                <div className={styles.blacklistName}>
                  {row.full_name}
                  {row.birth_date && <span className={styles.blacklistSub}>{formatDate(row.birth_date)}</span>}
                </div>
                <div className={styles.blacklistCell}>{row.snils || '—'}</div>
                <div className={styles.blacklistCell}>{row.email || '—'}</div>
                <div className={styles.blacklistCell}>
                  {row.created_by_name}
                  <span className={styles.blacklistSub}>{formatDate(row.created_at)}</span>
                </div>
                <div className={styles.blacklistCell} title={row.reason}>{row.reason}</div>
                <div className={styles.blacklistCell}>
                  <span className={`${styles.blacklistChip} ${status.className}`}>{status.text}</span>
                </div>
                <div className={styles.blacklistActions}>
                  {row.removed_at ? (
                    <span className={styles.blacklistSub} title={row.removal_reason ?? ''}>
                      снял {row.removed_by_name}
                    </span>
                  ) : (
                    <>
                      {row.targets_failed > 0 && (
                        <button
                          className={styles.cancelBtn}
                          onClick={() => handleRetry(row)}
                          disabled={retryingId === row.id}
                        >
                          {retryingId === row.id ? '...' : 'Повторить'}
                        </button>
                      )}
                      <button className={styles.dangerBtn} onClick={() => setRemoveTarget(row)}>
                        Снять
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {addOpen && (
        <BlacklistAddModal
          onClose={() => setAddOpen(false)}
          onDone={async () => {
            setAddOpen(false);
            await reload();
          }}
        />
      )}

      {removeTarget && (
        <BlacklistRemoveModal
          entry={removeTarget}
          onClose={() => setRemoveTarget(null)}
          onDone={async () => {
            setRemoveTarget(null);
            await reload();
          }}
        />
      )}
    </>
  );
};
