/**
 * Комментарий доплаты — как CHECK payroll_supplement_comment (плановая, миграция 364),
 * payroll_one_time_supplement_comment (разовая, миграция 385) и проверка сервера.
 */
export const PLANNED_SUPPLEMENT_COMMENT_MAX_LENGTH = 500;

/**
 * Комментарий плановой или разовой доплаты из поля: пробелы по краям срезаются, пусто — null; длиннее предела —
 * ошибка. Общий для «Справочника» (payrollRegistryForms.ts) и окна сотрудника (payrollTermsForm.ts).
 */
export const parsePlannedComment = (raw: string): { comment: string | null } | { error: string } => {
  const comment = raw.trim();
  if (comment.length > PLANNED_SUPPLEMENT_COMMENT_MAX_LENGTH) {
    return { error: `Комментарий — не больше ${PLANNED_SUPPLEMENT_COMMENT_MAX_LENGTH} символов` };
  }
  return { comment: comment || null };
};
