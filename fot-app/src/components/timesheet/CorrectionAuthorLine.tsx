import { type FC } from 'react';
import { isWrittenByApproval, useCorrectionSourceRequest } from '../../hooks/useCorrectionSourceRequest';
import { formatFioShort } from '../../utils/formatFio';

interface ICorrectionAuthorLineProps {
  adjustmentId: number | null;
  authorName: string | null;
  correctedAt: string | null;
  formatDate: (iso: string) => string;
}

/**
 * Строка автора в карточке объекта. Обычно — кто и когда последним записал
 * корректировку. Если запись сделало согласование заявления — «✎ Подано · заявитель ·
 * время подачи»: иначе имя заявителя стояло бы рядом со временем согласования.
 */
export const CorrectionAuthorLine: FC<ICorrectionAuthorLineProps> = ({ adjustmentId, authorName, correctedAt, formatDate }) => {
  const { data: source, isLoading } = useCorrectionSourceRequest(adjustmentId, correctedAt);
  // Пока не ясно, из заявления ли запись, — не показываем, чтобы строка не мигала.
  if (isLoading) return null;
  if (source && isWrittenByApproval(correctedAt, source.reviewed_at)) {
    const author = formatFioShort(source.author_name ?? authorName);
    return (
      <div className="ts-correction-view-author">
        ✎ Подано{author && ` · ${author}`} · {formatDate(source.submitted_at)}
      </div>
    );
  }
  if (!authorName && !correctedAt) return null;
  return (
    <div className="ts-correction-view-author">
      ✎ {authorName}
      {authorName && correctedAt && ', '}
      {correctedAt && formatDate(correctedAt)}
    </div>
  );
};
