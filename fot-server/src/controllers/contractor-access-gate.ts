/**
 * Гейты доступа к разделу «Подрядчики» (/admin/contractor-approvals).
 *
 * Раньше контроллеры проверяли только «системный админ» (scope.roots === 'all'),
 * из-за чего роль с грантом на страницу (например «Отдел безопасности») получала
 * 403 на все данные раздела. Теперь пускаем:
 *   • системного админа (scope.roots === 'all');
 *   • НЕ-админскую роль с явным грантом на нужный ключ страницы.
 * Компанийный админ (is_admin && roots !== 'all') в раздел по-прежнему не проходит —
 * скоуп компаний на подрядчиков не распространяется.
 */
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';
import { resolveCompanyScope } from '../services/data-scope.service.js';
import { hasPageView, hasPageEdit } from '../services/access-control.service.js';

/** Основной ключ раздела: полный доступ ко всем вкладкам. */
export const CONTRACTOR_SECTION_PAGE_KEY = '/admin/contractor-approvals';
/** Технический ключ узкой роли: только вкладка «Заявки на согласование». */
export const SUBMISSIONS_PAGE_KEY = '/admin/contractor-approvals/submissions';
/** Технический ключ узкой роли: только вкладка «ОТиТБ». */
export const OTITB_PAGE_KEY = '/admin/contractor-approvals/otitb';

export type ContractorAccessAction = 'view' | 'edit';

/** Системный админ ИЛИ не-админская роль с грантом на любой из ключей. Иначе 403. */
const ensureAnyPageGrant = async (
  req: AuthenticatedRequest,
  res: Response,
  action: ContractorAccessAction,
  keys: readonly string[],
): Promise<boolean> => {
  const scope = await resolveCompanyScope(req);
  if (scope.roots === 'all') return true;

  if (!req.user.is_admin) {
    const checks = await Promise.all(
      keys.map(key => (action === 'edit'
        ? hasPageEdit(req.user.role_code, key)
        : hasPageView(req.user.role_code, key))),
    );
    if (checks.some(Boolean)) return true;
  }

  res.status(403).json({ success: false, error: 'Недостаточно прав' });
  return false;
};

/** Раздел целиком (пул, отправленные, мониторинг, удаления) — только основной ключ. */
export const ensureContractorSectionAccess = (
  req: AuthenticatedRequest,
  res: Response,
  action: ContractorAccessAction,
): Promise<boolean> => ensureAnyPageGrant(req, res, action, [CONTRACTOR_SECTION_PAGE_KEY]);

/** Вкладка «Заявки на согласование»: основной ключ ИЛИ технический /submissions. */
export const ensureSubmissionsAccess = (
  req: AuthenticatedRequest,
  res: Response,
  action: ContractorAccessAction,
): Promise<boolean> =>
  ensureAnyPageGrant(req, res, action, [CONTRACTOR_SECTION_PAGE_KEY, SUBMISSIONS_PAGE_KEY]);

/** Вкладка «ОТиТБ» (реестр инструктажа): основной ключ ИЛИ технический /otitb. */
export const ensureOtitbAccess = (
  req: AuthenticatedRequest,
  res: Response,
  action: ContractorAccessAction,
): Promise<boolean> =>
  ensureAnyPageGrant(req, res, action, [CONTRACTOR_SECTION_PAGE_KEY, OTITB_PAGE_KEY]);
