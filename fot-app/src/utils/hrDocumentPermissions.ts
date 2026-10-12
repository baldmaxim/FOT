interface IHrDocumentPermissionsInput {
  /** Правка реквизитов (/staff-control/hr-profiles edit) или администратор. */
  canEdit: boolean;
  /** Просмотр реквизитов (/staff-control/hr-profiles view). */
  canViewProfiles: boolean;
  /** Ключ «документы без правки полей» (/staff-control/hr-documents edit). */
  hasDocumentsKey: boolean;
  /** id текущего пользователя — им помечены его загрузки (documents.uploaded_by). */
  userId: string | null;
}

interface IHrDocumentPermissions {
  /** Загрузка сканов, просмотр и скачивание файлов, кнопка «Завести реквизиты». */
  canDocs: boolean;
  /** Полные номера показываются сразу при открытии — без кнопки «Показать номера». */
  autoUnmask: boolean;
  /** Что открыть после «Завести реквизиты»: форму правки или вкладку «Файлы». */
  afterCreate: 'edit' | 'files';
  /** Удаление и повторное распознавание файла. */
  canManageDoc: (doc: { uploaded_by: string }) => boolean;
}

/**
 * Права в модалке «Реквизиты». Зеркало серверного hr-documents-access.service:
 * ключ документов (вместе с просмотром реквизитов) даёт загрузку, сканы и полные номера,
 * но не правку полей; удалять и распознавать заново можно только свои файлы.
 */
export const resolveHrDocumentPermissions = ({
  canEdit,
  canViewProfiles,
  hasDocumentsKey,
  userId,
}: IHrDocumentPermissionsInput): IHrDocumentPermissions => {
  const documentsOnly = !canEdit && canViewProfiles && hasDocumentsKey;
  return {
    canDocs: canEdit || documentsOnly,
    autoUnmask: documentsOnly,
    afterCreate: canEdit ? 'edit' : 'files',
    canManageDoc: doc => canEdit || (documentsOnly && !!userId && doc.uploaded_by === userId),
  };
};
