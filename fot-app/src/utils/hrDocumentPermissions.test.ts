import { describe, expect, it } from 'vitest';
import { resolveHrDocumentPermissions, type IHrEmployeeAccess } from './hrDocumentPermissions';

const OWN = { uploaded_by: 'tk-1' };
const FOREIGN = { uploaded_by: 'hr-1' };

/** Права на сотрудника от сервера. */
const IN_WRITE_SCOPE: IHrEmployeeAccess = { canEdit: true, canUnmask: true, canCreate: false };
const READ_SCOPE_ONLY: IHrEmployeeAccess = { canEdit: false, canUnmask: true, canCreate: false };
const OUT_OF_SCOPE: IHrEmployeeAccess = { canEdit: false, canUnmask: false, canCreate: false };
const DOCUMENTS_HOLDER: IHrEmployeeAccess = { canEdit: false, canUnmask: true, canCreate: true };

describe('resolveHrDocumentPermissions', () => {
  describe('табельщица: просмотр реквизитов + ключ документов', () => {
    const perms = resolveHrDocumentPermissions({
      hasProfilesEdit: false, canViewProfiles: true, hasDocumentsKey: true, userId: 'tk-1', employee: DOCUMENTS_HOLDER,
    });

    it('загружает, смотрит и скачивает сканы, но поля не правит', () => {
      expect(perms.canUpload).toBe(true);
      expect(perms.canViewFiles).toBe(true);
      expect(perms.canEditFields).toBe(false);
    });

    it('видит полные номера сразу, без кнопки', () => {
      expect(perms.autoUnmask).toBe(true);
      expect(perms.canUnmask).toBe(false);
    });

    it('после «Завести реквизиты» попадает во вкладку «Файлы», а не в форму правки', () => {
      expect(perms.afterCreate).toBe('files');
      expect(perms.canCreate).toBe(true);
    });

    it('удаляет и распознаёт заново только свои файлы', () => {
      expect(perms.canManageDoc(OWN)).toBe(true);
      expect(perms.canManageDoc(FOREIGN)).toBe(false);
    });
  });

  describe('только просмотр реквизитов (роль «Учёт проживания»)', () => {
    const perms = resolveHrDocumentPermissions({
      hasProfilesEdit: false, canViewProfiles: true, hasDocumentsKey: false, userId: 'u-1', employee: OUT_OF_SCOPE,
    });

    it('ни правки, ни загрузки, ни сканов, ни полных номеров', () => {
      expect(perms.canEditFields).toBe(false);
      expect(perms.canUpload).toBe(false);
      expect(perms.canViewFiles).toBe(false);
      expect(perms.canUnmask).toBe(false);
      expect(perms.autoUnmask).toBe(false);
      expect(perms.canCreate).toBe(false);
    });

    it('даже свой файл не трогает', () => {
      expect(perms.canManageDoc({ uploaded_by: 'u-1' })).toBe(false);
    });
  });

  it('ключ документов без просмотра реквизитов ничего не даёт', () => {
    const perms = resolveHrDocumentPermissions({
      hasProfilesEdit: false, canViewProfiles: false, hasDocumentsKey: true, userId: 'tk-1', employee: null,
    });
    expect(perms.canUpload).toBe(false);
    expect(perms.canViewFiles).toBe(false);
    expect(perms.autoUnmask).toBe(false);
    expect(perms.canManageDoc(OWN)).toBe(false);
  });

  it('без id пользователя «своих» файлов нет', () => {
    const perms = resolveHrDocumentPermissions({
      hasProfilesEdit: false, canViewProfiles: true, hasDocumentsKey: true, userId: null, employee: DOCUMENTS_HOLDER,
    });
    expect(perms.canManageDoc({ uploaded_by: '' })).toBe(false);
  });

  describe('отдел кадров с правкой реквизитов, сотрудник в охвате записи — как раньше', () => {
    const perms = resolveHrDocumentPermissions({
      hasProfilesEdit: true, canViewProfiles: true, hasDocumentsKey: false, userId: 'hr-1', employee: IN_WRITE_SCOPE,
    });

    it('правит поля и работает с любыми файлами', () => {
      expect(perms.canEditFields).toBe(true);
      expect(perms.canUpload).toBe(true);
      expect(perms.canViewFiles).toBe(true);
      expect(perms.canManageDoc(OWN)).toBe(true);
      expect(perms.canManageDoc(FOREIGN)).toBe(true);
    });

    it('номера — по кнопке «Показать номера», после создания — форма правки', () => {
      expect(perms.canUnmask).toBe(true);
      expect(perms.autoUnmask).toBe(false);
      expect(perms.afterCreate).toBe('edit');
    });

    it('лишний ключ документов поведение не меняет', () => {
      const both = resolveHrDocumentPermissions({
        hasProfilesEdit: true, canViewProfiles: true, hasDocumentsKey: true, userId: 'hr-1', employee: IN_WRITE_SCOPE,
      });
      expect(both.autoUnmask).toBe(false);
      expect(both.afterCreate).toBe('edit');
    });
  });

  describe('правка реквизитов, сотрудник вне охвата записи', () => {
    it('в охвате чтения: номера и сканы есть, правки и загрузки нет', () => {
      const perms = resolveHrDocumentPermissions({
        hasProfilesEdit: true, canViewProfiles: true, hasDocumentsKey: false, userId: 'hr-1', employee: READ_SCOPE_ONLY,
      });
      expect(perms.canUnmask).toBe(true);
      expect(perms.canViewFiles).toBe(true);
      expect(perms.canEditFields).toBe(false);
      expect(perms.canUpload).toBe(false);
      expect(perms.canManageDoc(FOREIGN)).toBe(false);
    });

    it('вне охвата (флаг «Все отделы на чтение»): только чтение', () => {
      const perms = resolveHrDocumentPermissions({
        hasProfilesEdit: true, canViewProfiles: true, hasDocumentsKey: false, userId: 'hr-1', employee: OUT_OF_SCOPE,
      });
      expect(perms.canEditFields).toBe(false);
      expect(perms.canUnmask).toBe(false);
      expect(perms.canUpload).toBe(false);
      expect(perms.canViewFiles).toBe(false);
    });

    it('с ключом документов не переходит в режим «только документы»', () => {
      const perms = resolveHrDocumentPermissions({
        hasProfilesEdit: true, canViewProfiles: true, hasDocumentsKey: true, userId: 'hr-1', employee: OUT_OF_SCOPE,
      });
      expect(perms.autoUnmask).toBe(false);
      expect(perms.canUpload).toBe(false);
      expect(perms.canViewFiles).toBe(false);
      expect(perms.canManageDoc({ uploaded_by: 'hr-1' })).toBe(false);
    });
  });

  it('пока права на сотрудника не пришли — кнопок нет', () => {
    const perms = resolveHrDocumentPermissions({
      hasProfilesEdit: true, canViewProfiles: true, hasDocumentsKey: false, userId: 'hr-1', employee: null,
    });
    expect(perms.canEditFields).toBe(false);
    expect(perms.canUnmask).toBe(false);
    expect(perms.canCreate).toBe(false);
  });

  it('сервер не разрешил «Завести реквизиты» — кнопки нет', () => {
    const perms = resolveHrDocumentPermissions({
      hasProfilesEdit: true, canViewProfiles: true, hasDocumentsKey: false, userId: 'hr-1',
      employee: { canEdit: false, canUnmask: false, canCreate: false },
    });
    expect(perms.canCreate).toBe(false);
  });
});
