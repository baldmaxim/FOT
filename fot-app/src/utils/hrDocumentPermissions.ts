/** Права на конкретного сотрудника от сервера (GET /hr-profiles/:id → meta, 404 → can_create). */
export interface IHrEmployeeAccess {
  /** Правка полей, ЗУП, расхождения OCR, загрузка — сотрудник в охвате записи. */
  canEdit: boolean;
  /** «Показать номера» и сканы — правка реквизитов и сотрудник в охвате чтения. */
  canUnmask: boolean;
  /** «Завести реквизиты». */
  canCreate: boolean;
}

interface IHrDocumentPermissionsInput {
  /** Правка реквизитов (/staff-control/hr-profiles edit) или администратор — право роли. */
  hasProfilesEdit: boolean;
  /** Просмотр реквизитов (/staff-control/hr-profiles view). */
  canViewProfiles: boolean;
  /** Ключ «документы без правки полей» (/staff-control/hr-documents edit). */
  hasDocumentsKey: boolean;
  /** id текущего пользователя — им помечены его загрузки (documents.uploaded_by). */
  userId: string | null;
  /** Права на этого сотрудника от сервера; null — ещё не пришли. */
  employee: IHrEmployeeAccess | null;
}

interface IHrDocumentPermissions {
  /** «Редактировать», флаг ЗУП, применить / отклонить расхождение OCR. */
  canEditFields: boolean;
  /** Кнопка «Показать номера». */
  canUnmask: boolean;
  /** Загрузка сканов. */
  canUpload: boolean;
  /** Просмотр и скачивание сканов, панель «Оригинал». */
  canViewFiles: boolean;
  /** Кнопка «Завести реквизиты». */
  canCreate: boolean;
  /** Полные номера показываются сразу при открытии — без кнопки «Показать номера». */
  autoUnmask: boolean;
  /** Что открыть после «Завести реквизиты»: форму правки или вкладку «Файлы». */
  afterCreate: 'edit' | 'files';
  /** Удаление и повторное распознавание файла. */
  canManageDoc: (doc: { uploaded_by: string }) => boolean;
}

/**
 * Права в модалке «Реквизиты». Зеркало серверного hr-documents-access.service:
 * - режим «только документы» (ключ документов с просмотром, без правки) решает право роли, как на сервере, — не флаги
 *   сотрудника: держатель обоих ключей вне охвата в этот режим не попадает;
 * - с правкой реквизитов кнопки зависят от прав на этого сотрудника от сервера: вне охвата (роль с флагом «Все отделы
 *   на чтение») окно только для чтения, без кнопок, которые вернули бы 403.
 */
export const resolveHrDocumentPermissions = ({
  hasProfilesEdit,
  canViewProfiles,
  hasDocumentsKey,
  userId,
  employee,
}: IHrDocumentPermissionsInput): IHrDocumentPermissions => {
  const documentsOnly = !hasProfilesEdit && canViewProfiles && hasDocumentsKey;
  const canEditEmployee = hasProfilesEdit && employee?.canEdit === true;
  const canUnmaskEmployee = hasProfilesEdit && employee?.canUnmask === true;
  return {
    canEditFields: canEditEmployee,
    canUnmask: canUnmaskEmployee,
    canUpload: canEditEmployee || documentsOnly,
    canViewFiles: canUnmaskEmployee || documentsOnly,
    canCreate: employee?.canCreate === true,
    autoUnmask: documentsOnly,
    afterCreate: hasProfilesEdit ? 'edit' : 'files',
    canManageDoc: doc => canEditEmployee || (documentsOnly && !!userId && doc.uploaded_by === userId),
  };
};
