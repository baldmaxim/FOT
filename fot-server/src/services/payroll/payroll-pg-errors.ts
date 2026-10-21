/** Коды ошибок PostgreSQL, которые справочники «Зарплаты» превращают в понятный ответ. */
export const PG_UNIQUE_VIOLATION = '23505';
export const PG_FOREIGN_KEY_VIOLATION = '23503';
/** PostgreSQL 18 отдаёт нарушение ON DELETE RESTRICT своим кодом, до 18 — общим кодом внешнего ключа. */
const PG_RESTRICT_VIOLATION = '23001';

export const hasPgCode = (err: unknown, code: string): boolean =>
  typeof err === 'object' && err !== null && 'code' in err && err.code === code;

/** Строку нельзя удалить: на неё ссылаются (FK RESTRICT). */
export const isPgReferencedRow = (err: unknown): boolean =>
  hasPgCode(err, PG_FOREIGN_KEY_VIOLATION) || hasPgCode(err, PG_RESTRICT_VIOLATION);
