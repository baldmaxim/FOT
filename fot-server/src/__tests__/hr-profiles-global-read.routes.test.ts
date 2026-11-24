/**
 * Флаг роли «Все отделы на чтение» (view_all_departments) и окно «Реквизиты» (роль «Учёт проживания», 24.11.2026).
 *
 * Флаг открывает окно на чтение по сотруднику ВНЕ охвата отделов: профиль, история, расхождения OCR и список
 * документов — с номерами, замаскированными до последних 4 символов. Полные номера, сканы, загрузка, правка, ЗУП и
 * «Завести реквизиты» флаг не открывает — даже роли с правкой реквизитов. Без ключа «Реквизиты» флаг не даёт ничего
 * («Отдел безопасности»). Без флага — прежние 403.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const EMPLOYEE = 5001;

const st = vi.hoisted(() => ({
  profilesView: true,
  profilesEdit: false,
  readScope: false,
  writeScope: false,
  globalRead: true,
  profileExists: true,
}));

const pg = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  queryOne: pg.queryOne,
  query: pg.query,
  execute: vi.fn().mockResolvedValue(0),
  withTransaction: vi.fn(),
  getPool: vi.fn(),
  pool: vi.fn(),
}));

vi.mock('../services/access-control.service.js', () => ({
  resolveEffectivePageAccess: vi.fn(async (_req: unknown, page: string, action: 'view' | 'edit') => {
    if (page === '/staff-control/hr-profiles') return action === 'edit' ? st.profilesEdit : st.profilesView || st.profilesEdit;
    if (page === '/staff-control/hr-documents') return false;
    return true;
  }),
  hasPageView: vi.fn(async () => true),
}));

vi.mock('../services/hr-feature-flag.service.js', () => ({
  HR_PROFILES_ENABLED_KEY: 'hr_profiles_enabled',
  isHrProfilesEnabled: vi.fn(async () => true),
  requireHrEnabled: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
}));

vi.mock('../services/data-scope.service.js', () => ({
  canAccessEmployeeInScope: vi.fn(async () => st.readScope),
  canWriteEmployeeInScope: vi.fn(async () => st.writeScope),
  hasGlobalDepartmentReadScope: vi.fn(async () => st.globalRead),
  resolveAccessibleDepartmentIds: vi.fn(async () => []),
  resolveAccessibleEmployeeIds: vi.fn(async () => new Set<number>()),
  resolveScopedDepartmentId: vi.fn(async () => null),
  resolveWritableScopedDepartmentId: vi.fn(async () => null),
}));

vi.mock('../services/employee-scope-filter.service.js', () => ({
  canSeeEmployeeInStaffList: vi.fn(async () => st.readScope),
  resolveStaffRosterEmployeeIds: vi.fn(async () => new Set<number>()),
}));

vi.mock('../services/audit.service.js', () => ({
  auditService: { logFromRequest: vi.fn(async () => undefined) },
  AUDIT_ACTIONS: new Proxy({}, { get: (_t, k) => String(k) }),
}));

vi.mock('../services/hr-crypto.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/hr-crypto.service.js')>()),
  isHrCryptoConfigured: () => true,
  // «Зашифрованное» значение в тесте — сам текст.
  decryptFieldSafe: (value: string | null) => value,
}));

const docRow = {
  id: 42,
  employee_id: EMPLOYEE,
  category: 'hr_passport',
  file_name: 'passport.jpg',
  mime_type: 'image/jpeg',
  file_size: 1024,
  r2_key: 'hr/42.bin',
  deleted_at: null,
  recognition_status: 'done',
  uploaded_by: 'someone',
};

const writes = vi.hoisted(() => ({ upload: 0, create: 0, update: 0, zup: 0, bytes: 0 }));

vi.mock('../services/hr-documents.service.js', () => ({
  HrDocumentError: class extends Error { constructor(msg: string, readonly status = 400) { super(msg); } },
  HR_FILE_MAX_BYTES: 20 * 1024 * 1024,
  RECOGNIZABLE_MIME: new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),
  uploadHrDocument: vi.fn(async () => { writes.upload += 1; return docRow; }),
  loadHrDocument: vi.fn(async () => docRow),
  loadDecryptedBytes: vi.fn(async () => { writes.bytes += 1; return Buffer.from('scan'); }),
  softDeleteHrDocument: vi.fn(async () => undefined),
  resolveHrDocumentOwner: vi.fn(async () => ({ employeeId: EMPLOYEE, draftId: null })),
  listEmployeeHrDocumentRows: vi.fn(async () => []),
  listDraftHrDocumentRows: vi.fn(async () => []),
  groupIntoSlots: vi.fn(() => []),
  countCompleteness: vi.fn(() => ({ required: 0, filled: 0 })),
  toPublic: vi.fn((row: typeof docRow) => ({ ...row, ocr_supported: true })),
  readRecognitionResult: vi.fn(() => null),
}));

vi.mock('../services/hr-ocr/worker.js', () => ({
  enqueueHrOcr: vi.fn(async () => undefined),
  startHrOcrWorker: vi.fn(),
  stopHrOcrWorker: vi.fn(),
}));

vi.mock('../services/hr-draft.service.js', () => ({ loadDraft: vi.fn(async () => null) }));

const hrProfile = vi.hoisted(() => ({ listHistory: vi.fn() }));
vi.mock('../services/hr-profile.service.js', () => ({
  loadProfileRow: vi.fn(async () => (st.profileExists ? { employee_id: EMPLOYEE, passport_type: 'russian' } : null)),
  buildProfileView: vi.fn(async (_row: unknown, opts: { unmask: boolean }) => ({ unmask: opts.unmask, document_slots: [] })),
  rowToPlainFields: vi.fn(() => ({})),
  listHistory: hrProfile.listHistory,
  createProfile: vi.fn(async () => { writes.create += 1; return { created: true }; }),
  updateProfile: vi.fn(async () => { writes.update += 1; return { changedFields: [], zupReset: false }; }),
  setZupUploaded: vi.fn(async () => { writes.zup += 1; }),
}));

const app = (await import('../app.js')).default;

const token = (): string => jwt.sign(
  {
    sub: 'housing-user',
    email: 'housing@example.com',
    system_role_id: 'role-uuid',
    role_code: 'checks',
    is_admin: false,
    employee_variant: 'office',
    employee_id: 15745,
    department_id: null,
    is_approved: true,
    two_factor_enabled: false,
    two_factor_verified: true,
  },
  process.env.JWT_SECRET!,
  { expiresIn: '1h' },
);

const get = (url: string) => request(app).get(url).set('Authorization', `Bearer ${token()}`);

const d = process.env.CODEX_SANDBOX ? describe.skip : describe;

d('«Реквизиты»: флаг «Все отделы на чтение», сотрудник вне охвата', () => {
  beforeEach(() => {
    Object.assign(st, {
      profilesView: true, profilesEdit: false, readScope: false, writeScope: false, globalRead: true, profileExists: true,
    });
    Object.assign(writes, { upload: 0, create: 0, update: 0, zup: 0, bytes: 0 });
    pg.queryOne.mockReset().mockResolvedValue({ token_version: 0, id: EMPLOYEE, full_name: 'Тест Тестов' });
    pg.query.mockReset().mockImplementation(async (sql: string) => (sql.includes('employee_hr_ocr_conflicts')
      ? [{
        id: 1, employee_id: EMPLOYEE, document_id: 42, document_name: 'passport.jpg', document_category: 'hr_passport',
        field_name: 'passport_number', current_value_enc: '4510123456', ocr_value_enc: '4510123457',
        status: 'open', resolved_at: null, created_at: '2026-11-24',
      }]
      : []));
    hrProfile.listHistory.mockReset().mockResolvedValue([]);
  });

  describe('просмотр реквизитов + флаг', () => {
    it('профиль открывается: номера скрыты, правки и раскрытия нет', async () => {
      const res = await get(`/api/hr-profiles/${EMPLOYEE}`);
      expect(res.status).toBe(200);
      expect(res.body.data.unmask).toBe(false);
      expect(res.body.meta).toEqual({ can_edit: false, can_unmask: false });
    });

    it('история — с маской', async () => {
      const res = await get(`/api/hr-profiles/${EMPLOYEE}/history`);
      expect(res.status).toBe(200);
      expect(hrProfile.listHistory).toHaveBeenCalledWith(EMPLOYEE, { unmask: false });
    });

    it('расхождения OCR — оба значения до последних 4 символов', async () => {
      const res = await get(`/api/hr-profiles/${EMPLOYEE}/ocr-conflicts`);
      expect(res.status).toBe(200);
      expect(res.body.data[0].current_value).toBe('••••••3456');
      expect(res.body.data[0].ocr_value).toBe('••••••3457');
    });

    it('список документов (без содержимого) открывается', async () => {
      const res = await get(`/api/hr-profiles/${EMPLOYEE}/documents`);
      expect(res.status).toBe(200);
    });
  });

  describe('правка реквизитов + флаг: вне охвата записи ничего не открывается', () => {
    beforeEach(() => { st.profilesEdit = true; });

    it('профиль: can_edit и can_unmask — false', async () => {
      const res = await get(`/api/hr-profiles/${EMPLOYEE}`);
      expect(res.status).toBe(200);
      expect(res.body.meta).toEqual({ can_edit: false, can_unmask: false });
    });

    it('история не раскрывает номера', async () => {
      await get(`/api/hr-profiles/${EMPLOYEE}/history`);
      expect(hrProfile.listHistory).toHaveBeenCalledWith(EMPLOYEE, { unmask: false });
    });

    it('реквизиты не заведены → can_create false', async () => {
      st.profileExists = false;
      const res = await get(`/api/hr-profiles/${EMPLOYEE}`);
      expect(res.status).toBe(404);
      expect(res.body.data.can_create).toBe(false);
    });

    it.each([
      ['get', `/api/hr-profiles/${EMPLOYEE}/sensitive`],
      ['get', '/api/hr-profiles/documents/42/content'],
      ['put', `/api/hr-profiles/${EMPLOYEE}`],
      ['post', `/api/hr-profiles/${EMPLOYEE}`],
      ['patch', `/api/hr-profiles/${EMPLOYEE}/zup`],
    ])('%s %s → 403', async (method, url) => {
      const res = await (request(app) as unknown as Record<string, (u: string) => request.Test>)[method](url)
        .set('Authorization', `Bearer ${token()}`)
        .send(method === 'patch' ? { is_uploaded: true } : {});
      expect(res.status).toBe(403);
      expect(writes).toEqual({ upload: 0, create: 0, update: 0, zup: 0, bytes: 0 });
    });

    it('загрузка скана → 403', async () => {
      const res = await request(app)
        .post(`/api/hr-profiles/${EMPLOYEE}/documents`)
        .set('Authorization', `Bearer ${token()}`)
        .field('type', 'passport')
        .attach('file', Buffer.from('jpeg-bytes'), { filename: 'passport.jpg', contentType: 'image/jpeg' });
      expect(res.status).toBe(403);
      expect(writes.upload).toBe(0);
    });
  });

  describe('прежнее поведение сохраняется', () => {
    it.each([
      `/api/hr-profiles/${EMPLOYEE}`,
      `/api/hr-profiles/${EMPLOYEE}/history`,
      `/api/hr-profiles/${EMPLOYEE}/ocr-conflicts`,
      `/api/hr-profiles/${EMPLOYEE}/documents`,
    ])('без флага: %s → 403', async (url) => {
      st.globalRead = false;
      expect((await get(url)).status).toBe(403);
    });

    it.each([
      `/api/hr-profiles/${EMPLOYEE}`,
      `/api/hr-profiles/${EMPLOYEE}/documents`,
    ])('флаг без ключа «Реквизиты» («Отдел безопасности»): %s → 403', async (url) => {
      st.profilesView = false;
      expect((await get(url)).status).toBe(403);
    });

    it('правка в охвате чтения без охвата записи: номера раскрываются, править нельзя', async () => {
      Object.assign(st, { profilesEdit: true, readScope: true, writeScope: false, globalRead: false });
      const res = await get(`/api/hr-profiles/${EMPLOYEE}`);
      expect(res.status).toBe(200);
      expect(res.body.meta).toEqual({ can_edit: false, can_unmask: true });
      await get(`/api/hr-profiles/${EMPLOYEE}/history`);
      expect(hrProfile.listHistory).toHaveBeenCalledWith(EMPLOYEE, { unmask: true });
    });

    it('правка в охвате записи: всё как было', async () => {
      Object.assign(st, { profilesEdit: true, readScope: true, writeScope: true, globalRead: false });
      const res = await get(`/api/hr-profiles/${EMPLOYEE}`);
      expect(res.body.meta).toEqual({ can_edit: true, can_unmask: true });
    });
  });
});
