// Доступ к «Реквизитам» без права правки полей — ключ /staff-control/hr-documents.
//
// Держатель ключа (вместе с просмотром реквизитов) загружает сканы на распознавание,
// открывает и скачивает файлы, видит полные номера и может завести пустые реквизиты.
// Править поля, ЗУП и конфликты распознавания он не может — это остаётся правке реквизитов.
//
// Круг сотрудников — как в списке «Управления кадрами» (canSeeEmployeeInStaffList), а не
// общий скоуп: тот добавляет табельщице всех, кто проходит на её объекты.

import { PAGE_PATHS } from '../config/access-control.js';
import { PAGE_KEY_HR_PROFILES } from '../config/hr-documents.js';
import { resolveEffectivePageAccess } from './access-control.service.js';
import { canSeeEmployeeInStaffList } from './employee-scope-filter.service.js';
import type { AuthenticatedRequest } from '../types/index.js';

/**
 * 'full' — правка реквизитов (прежние правила роута);
 * 'documents' — только ключ документов;
 * 'none' — доступа к записывающим роутам нет.
 */
export type HrDocumentsAccess = 'full' | 'documents' | 'none';

export const resolveHrDocumentsAccess = async (req: AuthenticatedRequest): Promise<HrDocumentsAccess> => {
  if (await resolveEffectivePageAccess(req, PAGE_KEY_HR_PROFILES, 'edit')) return 'full';
  const [canViewProfiles, hasDocumentsKey] = await Promise.all([
    resolveEffectivePageAccess(req, PAGE_KEY_HR_PROFILES, 'view'),
    resolveEffectivePageAccess(req, PAGE_PATHS.STAFF_CONTROL_HR_DOCUMENTS, 'edit'),
  ]);
  return canViewProfiles && hasDocumentsKey ? 'documents' : 'none';
};

/** Держатель ключа документов (без правки реквизитов) работает с этим сотрудником. */
export const canUseHrDocumentsForEmployee = async (
  req: AuthenticatedRequest,
  employeeId: number,
): Promise<boolean> =>
  (await resolveHrDocumentsAccess(req)) === 'documents' && canSeeEmployeeInStaffList(req, employeeId);
