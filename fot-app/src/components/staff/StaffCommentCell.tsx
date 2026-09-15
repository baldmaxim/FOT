import { memo, type FC } from 'react';
import { Pencil } from 'lucide-react';
import type { Employee } from '../../types';
import { staffCommentMetaOf } from './staffComment';

interface IStaffCommentCellProps {
  employee: Employee;
  /** Нет — только просмотр. */
  onEdit?: (employee: Employee) => void;
  /** Карточка на мобильном: автор и дата отдельной строкой (подсказки по наведению там нет). */
  variant?: 'table' | 'card';
}

/** «Комментарий»: до двух строк текста; полный текст, автор и дата — в подсказке и в окне. */
export const StaffCommentCell: FC<IStaffCommentCellProps> = memo(({ employee, onEdit, variant = 'table' }) => {
  const comment = employee.staff_comment ?? '';
  const meta = comment ? staffCommentMetaOf(employee) : '';
  const hint = comment ? `${comment}${meta ? `\n\n${meta}` : ''}` : '';
  const showMetaLine = variant === 'card' && Boolean(meta);

  const content = (
    <span className="sc-comment">
      <span className={comment ? 'sc-comment-text' : 'sc-comment-text sc-muted'}>{comment || '—'}</span>
      {showMetaLine && <span className="sc-comment-meta">{meta}</span>}
    </span>
  );

  if (!onEdit) {
    return <span className="sc-comment-view" title={hint || undefined}>{content}</span>;
  }
  return (
    <button
      type="button"
      className="sc-cell-edit sc-comment-edit"
      title={hint ? `${hint}\n\nНажмите, чтобы изменить` : 'Добавить комментарий'}
      aria-label={comment
        ? `Комментарий к ${employee.full_name}: ${comment}${meta ? `. ${meta}` : ''}. Изменить`
        : `Добавить комментарий к ${employee.full_name}`}
      onClick={event => { event.stopPropagation(); onEdit(employee); }}
    >
      {content}
      <Pencil size={12} aria-hidden="true" className="sc-cell-edit-icon" />
    </button>
  );
});
