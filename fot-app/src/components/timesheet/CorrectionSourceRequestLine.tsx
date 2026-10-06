import { type FC } from 'react';
import { useCorrectionSourceRequest } from '../../hooks/useCorrectionSourceRequest';
import { formatFioShort } from '../../utils/formatFio';

interface ICorrectionSourceRequestLineProps {
  adjustmentId: number;
  // Время последней записи корректировки: после правки часов ответ другой (строка
  // пропадает), поэтому кеш привязан и к нему.
  updatedAt?: string | null;
  formatDate: (iso: string) => string;
}

/**
 * «✓ Согласовано · Боюкян М. В. · 17.08.2026 17:08» — кто и когда согласовал заявление,
 * из которого получена корректировка. Нет такого заявления (ручная правка, часы
 * поправлены после согласования) или запрос упал — строки нет.
 */
export const CorrectionSourceRequestLine: FC<ICorrectionSourceRequestLineProps> = ({ adjustmentId, updatedAt, formatDate }) => {
  const { data } = useCorrectionSourceRequest(adjustmentId, updatedAt);
  if (!data) return null;
  const reviewer = formatFioShort(data.reviewer_name);
  return (
    <div className="ts-correction-view-approval">
      <span className="ts-correction-view-approval__label">✓ Согласовано</span>
      {reviewer && ` · ${reviewer}`}
      {` · ${formatDate(data.reviewed_at)}`}
    </div>
  );
};
