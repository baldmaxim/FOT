/**
 * Сквозная проверка доступа к кадровому модулю после снятия обязательной 2FA.
 *
 * Регресс, который надо удержать:
 *   1) пользователь с HR `edit` и БЕЗ 2FA грузит скан и запускает распознавание —
 *      именно ради этого requireHr2FA заменён на require2FA (2FA включили 3 человека
 *      из 1893, среди кадровиков — ни одного);
 *   2) пользователь только с HR `view` не может ни загрузить, ни посмотреть, ни
 *      раскрыть номера, ни удалить — 403.
 *
 * `npm run audit:routes` проверяет лишь наличие защиты, но не её семантику.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

vi.mock('../config/postgres.js', () => ({
  // Один мок на две роли: проверка token_version при аутентификации и строка
  // расхождения OCR — обеим достаточно этих полей.
  queryOne: vi.fn().mockResolvedValue({ token_version: 0, id: 7, employee_id: 5001, field_name: 'inn', status: 'open', document_id: 42, ocr_value_enc: null }),
  query: vi.fn().mockResolvedValue([]),
  execute: vi.fn().mockResolvedValue(0),
  withTransaction: vi.fn(),
  getPool: vi.fn(),
  pool: vi.fn(),
}));

/** Право на страницу выдаём по действию: edit-пользователь — всё, view-пользователь — только чтение. */
const access = vi.hoisted(() => ({ allowEdit: true, allowWriteScope: true }));
vi.mock('../services/access-control.service.js', () => ({
  resolveEffectivePageAccess: vi.fn(async (_req: unknown, _page: string, action: 'view' | 'edit') =>
    action === 'view' ? true : access.allowEdit),
  hasPageView: vi.fn(async () => true),
}));

// Флаг раскатки включён — иначе весь роутер отвечает 503.
vi.mock('../services/hr-feature-flag.service.js', () => ({
  HR_PROFILES_ENABLED_KEY: 'hr_profiles_enabled',
  isHrProfilesEnabled: vi.fn(async () => true),
  requireHrEnabled: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
}));

vi.mock('../services/data-scope.service.js', () => ({
  // Чтение доступно всегда, запись — по флагу: так моделируем заместителя, у
  // которого сотрудник в скоупе просмотра, но не в скоупе кадровых правок.
  canAccessEmployeeInScope: vi.fn(async () => true),
  resolveScopedDepartmentId: vi.fn(async () => null),
  canWriteEmployeeInScope: vi.fn(async () => access.allowWriteScope),
  resolveWritableScopedDepartmentId: vi.fn(async () => null),
}));

vi.mock('../services/audit.service.js', () => ({
  auditService: { logFromRequest: vi.fn(async () => undefined) },
  AUDIT_ACTIONS: new Proxy({}, { get: (_t, k) => String(k) }),
}));

const docRow = {
  id: 42,
  employee_id: 5001,
  category: 'hr_passport',
  file_name: 'passport.jpg',
  mime_type: 'image/jpeg',
  file_size: 1024,
  r2_key: 'hr/42.bin',
  deleted_at: null,
  recognition_status: 'pending',
};

const uploaded = vi.hoisted(() => ({ calls: 0 }));
const recognizeCalls = vi.hoisted(() => ({ calls: 0 }));

vi.mock('../services/hr-documents.service.js', () => ({
  HrDocumentError: class extends Error { constructor(msg: string, readonly status = 400) { super(msg); } },
  HR_FILE_MAX_BYTES: 20 * 1024 * 1024,
  uploadHrDocument: vi.fn(async () => { uploaded.calls += 1; return docRow; }),
  loadHrDocument: vi.fn(async () => docRow),
  loadDecryptedBytes: vi.fn(async () => Buffer.from('scan')),
  softDeleteHrDocument: vi.fn(async () => undefined),
  resolveHrDocumentOwner: vi.fn(async () => ({ employeeId: 5001, draftId: null })),
  listEmployeeHrDocumentRows: vi.fn(async () => []),
  listDraftHrDocumentRows: vi.fn(async () => []),
  groupIntoSlots: vi.fn(() => []),
  countCompleteness: vi.fn(() => ({ required: 0, filled: 0 })),
  toPublic: vi.fn((row: typeof docRow) => ({ ...row, ocr_supported: true })),
  readRecognitionResult: vi.fn(() => null),
}));

vi.mock('../services/hr-ocr/worker.js', () => ({
  enqueueHrOcr: vi.fn(async () => { recognizeCalls.calls += 1; }),
  startHrOcrWorker: vi.fn(),
  stopHrOcrWorker: vi.fn(),
}));

vi.mock('../services/hr-draft.service.js', () => ({ loadDraft: vi.fn(async () => null) }));
vi.mock('../services/hr-profile.service.js', () => ({
  loadProfileRow: vi.fn(async () => ({ employee_id: 5001, passport_type: 'russian' })),
  buildProfileView: vi.fn(() => ({})),
  rowToPlainFields: vi.fn(() => ({})),
}));

const app = (await import('../app.js')).default;

/** Токен без 2FA — типичный кадровик на проде. */
const token = (): string => jwt.sign(
  {
    sub: 'hr-access-user',
    email: 'hr@example.com',
    system_role_id: 'role-uuid',
    role_code: 'timekeeper',
    is_admin: false,
    employee_variant: 'office',
    employee_id: null,
    department_id: null,
    is_approved: true,
    two_factor_enabled: false,
    two_factor_verified: true,
  },
  process.env.JWT_SECRET!,
  { expiresIn: '1h' },
);

const d = process.env.CODEX_SANDBOX ? describe.skip : describe;

d('/api/hr-profiles — доступ без 2FA', () => {
  beforeEach(() => {
    access.allowEdit = true;
    access.allowWriteScope = true;
    uploaded.calls = 0;
    recognizeCalls.calls = 0;
  });

  it('HR edit без 2FA: загрузка скана проходит', async () => {
    const res = await request(app)
      .post('/api/hr-profiles/5001/documents')
      .set('Authorization', `Bearer ${token()}`)
      .field('type', 'passport')
      .attach('file', Buffer.from('jpeg-bytes'), { filename: 'passport.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBeLessThan(400);
    expect(uploaded.calls).toBe(1);
  });

  it('HR edit без 2FA: повторное распознавание запускается', async () => {
    const res = await request(app)
      .post('/api/hr-profiles/documents/42/recognize')
      .set('Authorization', `Bearer ${token()}`);

    expect(res.status).toBeLessThan(400);
    expect(recognizeCalls.calls).toBe(1);
  });

  it.each([
    ['post', '/api/hr-profiles/5001/documents'],
    ['get', '/api/hr-profiles/documents/42/content'],
    ['get', '/api/hr-profiles/5001/sensitive'],
    ['delete', '/api/hr-profiles/documents/42'],
  ])('только HR view: %s %s → 403', async (method, url) => {
    access.allowEdit = false;
    const res = await (request(app) as unknown as Record<string, (u: string) => request.Test>)[method](url)
      .set('Authorization', `Bearer ${token()}`);

    expect(res.status).toBe(403);
    expect(uploaded.calls).toBe(0);
  });

  it('«Применить расхождение» требует скоуп записи, а не просмотра', async () => {
    // Регресс: обработчик проверял canAccessEmployeeInScope, и заместитель мог
    // переписать паспорт или ИНН сотруднику, правка которого ему не положена.
    access.allowWriteScope = false;
    const res = await request(app)
      .post('/api/hr-profiles/ocr-conflicts/7/apply')
      .set('Authorization', `Bearer ${token()}`);

    expect(res.status).toBe(403);
  });

  it('со скоупом записи расхождение применяется', async () => {
    const res = await request(app)
      .post('/api/hr-profiles/ocr-conflicts/7/apply')
      .set('Authorization', `Bearer ${token()}`);

    expect(res.status).not.toBe(403);
  });

  it('только HR view: чтение профиля остаётся доступным', async () => {
    access.allowEdit = false;
    const res = await request(app).get('/api/hr-profiles/5001').set('Authorization', `Bearer ${token()}`);
    expect(res.status).not.toBe(403);
  });
});
