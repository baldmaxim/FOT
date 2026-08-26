import { type FC } from 'react';
import { AlertTriangle, CheckCircle2, Circle } from 'lucide-react';
import type { Timesheet1CState } from '../../services/timesheetApprovalService';

interface IProps {
  state: Timesheet1CState;
  /** false — официальная версия ещё не сформирована, выгружать нечего. */
  versionAvailable?: boolean;
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
 * stale — табель переоткрывали и правили, 1С приняла более раннюю редакцию;
 * not_exported — подтверждения ещё не было.
 */
export const Timesheet1CBadge: FC<IProps> = ({
  state,
  versionAvailable = true,
  ackedAt,
  documentRef,
  revision,
  compact = false,
}) => {
  const ackedText = ackedAt ? formatDateRu(ackedAt) : null;

  let icon = <Circle size={compact ? 12 : 13} />;
  let label = 'Не выгружен';
  let modifier = 'none';
  let tooltipLines: Array<string | null> = [];

  if (state === 'exported') {
    icon = <CheckCircle2 size={compact ? 12 : 13} />;
    label = 'В 1С';
    modifier = 'ok';
    tooltipLines = [
      ackedText ? `Выгружено в 1С: ${ackedText}` : 'Выгружено в 1С',
      documentRef ? `Документ: ${documentRef}` : null,
      revision != null ? `Редакция: ${revision}` : null,
    ];
  } else if (state === 'stale') {
    icon = <AlertTriangle size={compact ? 12 : 13} />;
    label = 'Изменён';
    modifier = 'stale';
    tooltipLines = [
      'Табель изменён после выгрузки — 1С заберёт новую редакцию',
      ackedText ? `Последняя выгрузка: ${ackedText}` : null,
      documentRef ? `Документ: ${documentRef}` : null,
    ];
  } else if (!versionAvailable) {
    tooltipLines = ['Версия для 1С ещё не сформирована'];
  } else {
    tooltipLines = ['1С ещё не забрала этот табель'];
  }

  const tooltip = tooltipLines.filter(Boolean).join('\n');

  return (
    <span
      className={`ts-1c-badge ts-1c-badge--${modifier}${compact ? ' ts-1c-badge--compact' : ''}`}
      title={tooltip}
      aria-label={`Выгрузка в 1С: ${label}`}
    >
      {icon}
      {!compact && label}
    </span>
  );
};
