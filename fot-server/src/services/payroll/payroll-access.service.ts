/**
 * Доступ к разделу «Зарплата» — список учёток payroll_section_access (миграция 310).
 *
 * Раздел видят и правят ТОЛЬКО учётки из списка — и администраторы тоже: роль доступа к
 * разделу не даёт и не отнимает. Список ведётся в БД (добавляют по id учётки), в окне
 * «Справочник» на «Расчётах» показывается только на чтение.
 *
 * Ветка в resolveEffectivePageAccess стоит первой, до обхода is_admin, + зеркало в
 * page_access на /auth/me. Охват — payroll-scope.service: админ из списка — своей компанией,
 * остальные — весь штат. Legacy-оклад вне раздела («+ Оклад», импорт из Excel, события
 * оклада в истории) список не открывает и не закрывает.
 */
import { PAGE_PATHS } from '../../config/access-control.js';
import { query } from '../../config/postgres.js';
import type { AuthenticatedRequest } from '../../types/index.js';

/**
 * Ключи раздела «Зарплата», которые открывает список. Точный список, а не префикс /salary/:
 * новый ключ раздела попадает сюда только явным решением (контрактный тест сверяет список
 * с каталогом).
 */
export const PAYROLL_SECTION_PAGES: readonly string[] = [
  PAGE_PATHS.SALARY_PAYMENTS,
  PAGE_PATHS.SALARY_PAYMENTS_CALCULATE,
  PAGE_PATHS.SALARY_PAYMENTS_APPROVE,
  PAGE_PATHS.SALARY_TERMS,
  PAGE_PATHS.SALARY_SICK_LEAVES,
  PAGE_PATHS.SALARY_VACATIONS,
  PAGE_PATHS.SALARY_DEDUCTIONS,
];

const PAYROLL_SECTION_PAGE_SET = new Set(PAYROLL_SECTION_PAGES);

/** Ключ раздела «Зарплата»: доступ к нему решает только список. */
export const isPayrollSectionPage = (pagePath: string): boolean => PAYROLL_SECTION_PAGE_SET.has(pagePath);

/**
 * Есть ли учётка в списке. Межзапросного кэша нет: удаление из списка действует сразу.
 * Предикат зовут page-гейты на путях без своей обработки ошибок БД, поэтому недоступная
 * база (в том числе таблица до миграции 310) означает «нет доступа» — fail-closed, а не 500.
 */
export async function hasPayrollSectionAccess(userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false;
  try {
    const rows = await query<{ user_id: string }>(
      'SELECT user_id FROM payroll_section_access WHERE user_id = $1::uuid',
      [userId],
    );
    return rows.length > 0;
  } catch (err) {
    console.warn('[payroll-access] section access check failed:', err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * Доступ текущего пользователя с кэшем на время HTTP-запроса (req.user): его читают
 * page-гейт и функции охвата «Зарплаты» в одном обработчике.
 */
export async function getRequestPayrollSectionAccess(req: AuthenticatedRequest): Promise<boolean> {
  if (req.user.__payroll_section_access !== undefined) return req.user.__payroll_section_access;
  const allowed = await hasPayrollSectionAccess(req.user.id);
  req.user.__payroll_section_access = allowed;
  return allowed;
}

export interface IPayrollSectionUser {
  user_id: string;
  full_name: string | null;
}

/** Список для окна «Справочник»: ФИО учёток по алфавиту. */
export const listPayrollSectionUsers = async (): Promise<IPayrollSectionUser[]> =>
  query<IPayrollSectionUser>(
    `SELECT a.user_id, up.full_name
       FROM payroll_section_access a
       JOIN user_profiles up ON up.id = a.user_id
      ORDER BY up.full_name NULLS LAST, a.user_id`,
  );
