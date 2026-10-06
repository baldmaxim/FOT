import { type FC } from 'react';
import { isWrittenByApproval, useCorrectionSourceRequest } from '../../hooks/useCorrectionSourceRequest';

interface ICorrectionAuthorBlockProps {
  adjustmentId: number | null;
  authorName: string | null;
  correctedAt: string | null;
  formatDate: (iso: string) => string;
}

/**
 * Плашка «автор последней корректировки + время» в правой колонке окна дня.
 * Если запись сделало согласование заявления — заявитель и «подано …»
 * (кто и когда согласовал — строкой «Согласовано» в карточке).
 */
export const CorrectionAuthorBlock: FC<ICorrectionAuthorBlockProps> = ({ adjustmentId, authorName, correctedAt, formatDate }) => {
  const { data: source, isLoading } = useCorrectionSourceRequest(adjustmentId, correctedAt);
  // Пока не ясно, из заявления ли запись, — не показываем, чтобы имя/время не мигали.
  if (isLoading) return null;
  const submitted = source && isWrittenByApproval(correctedAt, source.reviewed_at) ? source : null;
  const name = submitted ? (submitted.author_name ?? authorName) : authorName;
  const dateText = submitted
    ? `подано ${formatDate(submitted.submitted_at)}`
    : (correctedAt ? formatDate(correctedAt) : null);
  return (
    <div className="ts-corr-card__author">
      <span className="ts-corr-card__author-avatar" aria-hidden>
        {(name?.trim()?.[0] ?? '✎').toUpperCase()}
      </span>
      <span className="ts-corr-card__author-text">
        <span className="ts-corr-card__author-name">{name || 'Корректировка'}</span>
        {dateText && <span className="ts-corr-card__author-date">{dateText}</span>}
      </span>
    </div>
  );
};
