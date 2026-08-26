import { type FC } from 'react';
import { AlertTriangle, CheckCircle2, Circle, RefreshCw } from 'lucide-react';
import type { Timesheet1CState } from '../../services/timesheetApprovalService';

interface IProps {
  state: Timesheet1CState;
  /** Табель поправили в обход штатного закрытия — версия пересобирается фоном. */
  versionDirty?: boolean;
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
 * stale — табель правили после выгрузки, 1С приняла более раннюю редакцию;
 * not_exported — подтверждения ещё не было.
 */
export const Timesheet1CBadge: FC<IProps> = ({
  state,
  versionDirty = false,
  versionAvailable = true,
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

  let icon = <Circle size={iconSize} />;
  let label = 'Не выгружен';
  let modifier = 'none';
  let tooltipLines: Array<string | null> = [];

  if (state === 'exported') {
    icon = <CheckCircle2 size={iconSize} />;
    label = 'В 1С';
    modifier = 'ok';
    tooltipLines = [
      ackedText ? `Выгружено в 1С: ${ackedText}` : 'Выгружено в 1С',
      documentRef ? `Документ: ${documentRef}` : null,
      revision != null ? `Редакция: ${revision}` : null,
    ];
  } else if (state === 'stale') {
    icon = <AlertTriangle size={iconSize} />;
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
