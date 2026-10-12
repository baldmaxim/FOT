import { type FC } from 'react';
import { AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react';
import type { Timesheet1CState } from '../../services/timesheetApprovalService';

interface IProps {
  state: Timesheet1CState;
  /** Табель поправили в обход штатного закрытия — версия пересобирается фоном. */
  versionDirty?: boolean;
  ackedAt?: string | null;
  documentRef?: string | null;
  revision?: number | null;
  /** Показывать текст рядом с иконкой (в дереве отделов место ограничено). */
  compact?: boolean;
}

const formatDateRu = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  return `${dd}.${mm}.${date.getFullYear()} ${hh}:${mi}`;
};

/**
 * Статус выгрузки табеля в 1С.
 *
 * exported — 1С подтвердила приём текущей редакции;
 * stale — табель правили после выгрузки, 1С приняла более раннюю редакцию;
 * not_exported — подтверждения ещё не было: отметка не выводится.
 */
export const Timesheet1CBadge: FC<IProps> = ({
  state,
  versionDirty = false,
  ackedAt,
  documentRef,
  revision,
  compact = false,
}) => {
  const ackedText = ackedAt ? formatDateRu(ackedAt) : null;
  const iconSize = compact ? 12 : 13;

  // Пересборка важнее прочих состояний: пока она идёт, прежний статус вводит в
  // заблуждение — 1С этот табель сейчас всё равно не видит.
  if (versionDirty) {
    return (
      <span
        className={`ts-1c-badge ts-1c-badge--pending${compact ? ' ts-1c-badge--compact' : ''}`}
        title="Табель поправили — формируется новая редакция для 1С, обычно около минуты"
        aria-label="Выгрузка в 1С: пересчитывается"
      >
        <RefreshCw size={iconSize} />
        {!compact && 'Пересчитывается'}
      </span>
    );
  }

  // Подтверждения от 1С ещё не было — сообщать нечего, отметку не показываем.
  if (state === 'not_exported') return null;

  const exported = state === 'exported';
  const label = exported ? 'В 1С' : 'Изменён';
  const tooltip = (exported
    ? [
      ackedText ? `Выгружено в 1С: ${ackedText}` : 'Выгружено в 1С',
      documentRef ? `Документ: ${documentRef}` : null,
      revision != null ? `Редакция: ${revision}` : null,
    ]
    : [
      'Табель изменён после выгрузки — 1С заберёт новую редакцию',
      ackedText ? `Последняя выгрузка: ${ackedText}` : null,
      documentRef ? `Документ: ${documentRef}` : null,
    ]
  ).filter(Boolean).join('\n');

  return (
    <span
      className={`ts-1c-badge ts-1c-badge--${exported ? 'ok' : 'stale'}${compact ? ' ts-1c-badge--compact' : ''}`}
      title={tooltip}
      aria-label={`Выгрузка в 1С: ${label}`}
    >
      {exported ? <CheckCircle2 size={iconSize} /> : <AlertTriangle size={iconSize} />}
      {!compact && label}
    </span>
  );
};
