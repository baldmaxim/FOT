import { useState } from 'react';
import type { FC } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { adminService, type IPasswordResetRequest } from '../../services/adminService';
import { ApiError } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { PasswordResetLinkModal } from './PasswordResetLinkModal';
import styles from '../../pages/admin/Admin.module.css';

const errMsg = (e: unknown, fallback: string): string =>
  e instanceof ApiError ? e.message : fallback;

interface IPasswordResetRequestsTabProps {
  requests: IPasswordResetRequest[];
  loading?: boolean;
  onReload: () => Promise<void>;
}

interface ILinkModalState {
  resetUrl: string;
  expiresAt: string;
  userLabel: string;
}

const formatExpires = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
};

export const PasswordResetRequestsTab: FC<IPasswordResetRequestsTabProps> = ({ requests, loading = false, onReload }) => {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [generatingFor, setGeneratingFor] = useState<string | null>(null);
  const [linkModal, setLinkModal] = useState<ILinkModalState | null>(null);

  const handleGenerate = async (userId: string, userLabel: string) => {
    setGeneratingFor(userId);
    try {
      const { resetUrl, expiresAt } = await adminService.generatePasswordResetLink(userId);
      setLinkModal({ resetUrl, expiresAt, userLabel });
      await queryClient.invalidateQueries({ queryKey: ['admin-users', 'password-reset-requests'] });
      await onReload();
    } catch (e) {
      toast.error(errMsg(e, 'Не удалось создать ссылку для сброса'));
    } finally {
      setGeneratingFor(null);
    }
  };

  if (loading && requests.length === 0) {
    return <div className={styles.pendingEmpty}>Загрузка...</div>;
  }
  if (requests.length === 0) {
    return <div className={styles.pendingEmpty}>Активных запросов на сброс нет</div>;
  }

  return (
    <>
      <div className={styles.pendingList}>
        {requests.map(req => {
          const label = req.full_name || req.email || req.id;
          const isBusy = generatingFor === req.id;
          return (
            <div key={req.id} className={styles.pendingRow}>
              <div className={styles.pendingRowHeader}>
                <div className={styles.pendingRowInfo}>
                  <div className={styles.pendingRowName}>{req.full_name || 'Без имени'}</div>
                  <div className={styles.pendingRowEmail}>{req.email || '—'}</div>
                </div>
                <div className={styles.pendingRowDate}>
                  Истекает: {formatExpires(req.expires_at)}
                </div>
                <div className={styles.pendingRowActions}>
                  <button
                    className={styles.primaryBtn}
                    onClick={() => handleGenerate(req.id, label)}
                    disabled={isBusy}
                  >
                    {isBusy ? 'Создание...' : 'Сгенерировать новую ссылку'}
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {linkModal && (
        <PasswordResetLinkModal
          resetUrl={linkModal.resetUrl}
          expiresAt={linkModal.expiresAt}
          userLabel={linkModal.userLabel}
          onClose={() => setLinkModal(null)}
        />
      )}
    </>
  );
};
