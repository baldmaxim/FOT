import type { FC } from 'react';
import styles from './hiring.module.css';

export function initials(name: string | null | undefined): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map(p => p[0]?.toUpperCase() ?? '').join('') || '?';
}

const GRADS = [
  'linear-gradient(135deg,#3b82f6,#8b5cf6)',
  'linear-gradient(135deg,#f59e0b,#ef4444)',
  'linear-gradient(135deg,#22c55e,#0ea5e9)',
  'linear-gradient(135deg,#a78bfa,#ec4899)',
];
export function gradientFor(id: number | null | undefined): string {
  return GRADS[Math.abs(id ?? 0) % GRADS.length];
}

export const Avatar: FC<{ name: string | null; id?: number | null; unassigned?: boolean }> = ({ name, id, unassigned }) => {
  if (unassigned) return <span className={`${styles.ava} ${styles.avaUn}`}>?</span>;
  return <span className={styles.ava} style={{ background: gradientFor(id) }}>{initials(name)}</span>;
};

// Склонение дней переехало в utils/dateCompact — им пользуется и список заявлений.
export { pluralDays } from '../../../utils/dateCompact';

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
  } catch { return ''; }
}
