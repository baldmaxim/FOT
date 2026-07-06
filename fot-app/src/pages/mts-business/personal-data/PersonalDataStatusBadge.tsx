import { type FC } from 'react';
import { PD_STATUS_LABELS, PD_STATUS_KIND, type PdStatusKind } from '../mtsBusinessFormat';
import styles from './PersonalDataStatusBadge.module.css';

const KIND_CLASS: Record<PdStatusKind, string> = {
  ok: styles.ok,
  wait: styles.wait,
  err: styles.err,
  muted: styles.muted,
};

/**
 * Бейдж статуса подтверждения персональных данных (PersonalDataConfirmation).
 * Неизвестный статус показывается сырым значением; null — «не проверено».
 */
export const PersonalDataStatusBadge: FC<{ status: string | null | undefined }> = ({ status }) => {
  if (!status) return <span className={`${styles.badge} ${styles.muted}`}>не проверено</span>;
  const kind = PD_STATUS_KIND[status] ?? 'muted';
  return (
    <span className={`${styles.badge} ${KIND_CLASS[kind]}`} title={status}>
      {PD_STATUS_LABELS[status] ?? status}
    </span>
  );
};
