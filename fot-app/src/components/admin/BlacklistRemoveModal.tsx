import { useState } from 'react';
import type { FC } from 'react';
import { ModalShell } from '../ui/ModalShell';
import { ApiError } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { adminService, type IBlacklistRow } from '../../services/adminService';
import styles from '../../pages/admin/Admin.module.css';

const errMsg = (e: unknown, fallback: string): string =>
  e instanceof ApiError ? e.message : fallback;

interface IBlacklistRemoveModalProps {
  entry: IBlacklistRow;
  onClose: () => void;
  onDone: () => Promise<void> | void;
}

/**
 * Снятие из чёрного списка. Разблокировку в Sigur автоматически НЕ делаем:
 * человек может быть параллельно уволен, и автоснятие открыло бы ему доступ.
 * Поэтому предупреждаем и оставляем разблокировку отдельным осознанным
 * действием в разделе SIGUR.
 */
export const BlacklistRemoveModal: FC<IBlacklistRemoveModalProps> = ({ entry, onClose, onDone }) => {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSubmit = async () => {
    if (reason.trim().length < 3) {
      toast.error('Укажите причину снятия');
      return;
    }
    setSaving(true);
    try {
      await adminService.removeFromBlacklist(entry.id, reason.trim());
      toast.success('Снят из чёрного списка');
      await onDone();
    } catch (e) {
      toast.error(errMsg(e, 'Не удалось снять из чёрного списка'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell onClose={onClose} containerClassName={styles.blacklistModal}>
      {({ requestClose }) => (
        <>
          <div className={styles.blacklistModalHeader}>
            <h2>Снять из чёрного списка</h2>
          </div>

          <div className={styles.blacklistModalBody}>
            <div className={styles.blacklistPicked}>
              <strong>{entry.full_name}</strong>
              <span className={styles.blacklistSub}>Причина внесения: {entry.reason}</span>
            </div>

            <label className={styles.blacklistField}>
              <span>Причина снятия</span>
              <textarea
                rows={3}
                value={reason}
                onChange={e => setReason(e.target.value)}
                placeholder="Почему запрет снимается"
              />
            </label>

            {entry.targets_done > 0 && (
              <div className={styles.blacklistWarning}>
                Пропуск в Sigur останется заблокированным ({entry.targets_done} профилей).
                Разблокировать нужно вручную в разделе SIGUR — так снятие не откроет
                доступ тому, кто параллельно уволен.
              </div>
            )}

            <div className={styles.blacklistHint}>
              Запись останется в истории: видно, кто внёс, кто снял и почему.
            </div>
          </div>

          <div className={styles.blacklistModalFooter}>
            <button className={styles.cancelBtn} onClick={requestClose} disabled={saving}>
              Отмена
            </button>
            <button className={styles.dangerBtn} onClick={handleSubmit} disabled={saving}>
              {saving ? 'Снятие...' : 'Снять'}
            </button>
          </div>
        </>
      )}
    </ModalShell>
  );
};
