import { describe, expect, it } from 'vitest';
import { resolveHrDocumentPermissions } from './hrDocumentPermissions';

const OWN = { uploaded_by: 'tk-1' };
const FOREIGN = { uploaded_by: 'hr-1' };

describe('resolveHrDocumentPermissions', () => {
  describe('табельщица: просмотр реквизитов + ключ документов', () => {
    const perms = resolveHrDocumentPermissions({ canEdit: false, canViewProfiles: true, hasDocumentsKey: true, userId: 'tk-1' });

    it('загружает, смотрит и скачивает сканы', () => {
      expect(perms.canDocs).toBe(true);
    });

    it('видит полные номера сразу, без кнопки', () => {
      expect(perms.autoUnmask).toBe(true);
    });

    it('после «Завести реквизиты» попадает во вкладку «Файлы», а не в форму правки', () => {
      expect(perms.afterCreate).toBe('files');
    });

    it('удаляет и распознаёт заново только свои файлы', () => {
      expect(perms.canManageDoc(OWN)).toBe(true);
      expect(perms.canManageDoc(FOREIGN)).toBe(false);
    });
  });

  describe('только просмотр реквизитов, без ключа', () => {
    const perms = resolveHrDocumentPermissions({ canEdit: false, canViewProfiles: true, hasDocumentsKey: false, userId: 'tk-1' });

    it('ни загрузки, ни сканов, ни полных номеров', () => {
      expect(perms.canDocs).toBe(false);
      expect(perms.autoUnmask).toBe(false);
    });

    it('даже свой файл не трогает', () => {
      expect(perms.canManageDoc(OWN)).toBe(false);
    });
  });

  it('ключ документов без просмотра реквизитов ничего не даёт', () => {
    const perms = resolveHrDocumentPermissions({ canEdit: false, canViewProfiles: false, hasDocumentsKey: true, userId: 'tk-1' });
    expect(perms.canDocs).toBe(false);
    expect(perms.autoUnmask).toBe(false);
    expect(perms.canManageDoc(OWN)).toBe(false);
  });

  it('без id пользователя «своих» файлов нет', () => {
    const perms = resolveHrDocumentPermissions({ canEdit: false, canViewProfiles: true, hasDocumentsKey: true, userId: null });
    expect(perms.canManageDoc({ uploaded_by: '' })).toBe(false);
  });

  describe('отдел кадров с правкой реквизитов — как раньше', () => {
    const perms = resolveHrDocumentPermissions({ canEdit: true, canViewProfiles: true, hasDocumentsKey: false, userId: 'hr-1' });

    it('работает с любыми файлами', () => {
      expect(perms.canDocs).toBe(true);
      expect(perms.canManageDoc(OWN)).toBe(true);
      expect(perms.canManageDoc(FOREIGN)).toBe(true);
    });

    it('номера — по кнопке «Показать номера», после создания — форма правки', () => {
      expect(perms.autoUnmask).toBe(false);
      expect(perms.afterCreate).toBe('edit');
    });

    it('лишний ключ документов поведение не меняет', () => {
      const both = resolveHrDocumentPermissions({ canEdit: true, canViewProfiles: true, hasDocumentsKey: true, userId: 'hr-1' });
      expect(both.autoUnmask).toBe(false);
      expect(both.afterCreate).toBe('edit');
    });
  });
});
