/** Комментарий плановой доплаты — как CHECK payroll_supplement_comment (миграция 364) и проверка сервера. */
export const PLANNED_SUPPLEMENT_COMMENT_MAX_LENGTH = 500;

/**
 * Комментарий плановой доплаты из поля: пробелы по краям срезаются, пусто — null; длиннее предела — ошибка.
 * Общий для «Справочника» (payrollRegistryForms.ts) и окна сотрудника (payrollTermsForm.ts).
 */
export const parsePlannedComment = (raw: string): { comment: string | null } | { error: string } => {
  const comment = raw.trim();
  if (comment.length > PLANNED_SUPPLEMENT_COMMENT_MAX_LENGTH) {
    return { error: `Комментарий — не больше ${PLANNED_SUPPLEMENT_COMMENT_MAX_LENGTH} символов` };
  }
  return { comment: comment || null };
};
