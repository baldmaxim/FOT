/**
 * Ключ /staff-control/hr-documents — «Реквизиты: документы без правки полей».
 *
 * Табельщица с просмотром реквизитов и этим ключом:
 *   - видит полные номера, открывает и скачивает любой файл сотрудника своего списка кадров;
 *   - загружает сканы на распознавание и заводит ПУСТЫЕ реквизиты;
 *   - удаляет и распознаёт заново только свои файлы;
 *   - поля, ЗУП, расхождения OCR, черновики мастера не трогает.
 *
 * Круг сотрудников — список «Управления кадрами» (5001), а не общий скоуп: тот пускает
 * её и к людям её объектов вне папок (9001). Общий скоуп в моках намеренно «разрешает всё»,
 * чтобы 403 доказывал: решает именно список.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const ROSTER_EMPLOYEE = 5001;
const OBJECT_ONLY_EMPLOYEE = 9001;
const TIMEKEEPER_USER = 'tk-user';

type Mode = 'none' | 'view' | 'edit';
const s = vi.hoisted(() => ({
  /** Матрица роли: всё, чего здесь нет, — «Нет доступа». */
  matrix: {} as Record<string, 'none' | 'view' | 'edit'>,
  profileExists: true,
  created: true,
  doc: {} as Record<string, unknown>,
  owner: { employeeId: null as number | null, draftId: null as string | null },
  draftCreatedBy: null as string | null,
  query: vi.fn(),
  createProfile: vi.fn(),
  buildProfileView: vi.fn(),
  uploadHrDocument: vi.fn(),
  softDeleteHrDocument: vi.fn(),
  enqueueHrOcr: vi.fn(),
  audit: vi.fn(),
  canWriteEmployeeInScope: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  // token_version для аутентификации + строка сотрудника / расхождения OCR.
  queryOne: vi.fn().mockResolvedValue({ token_version: 0, id: 7, employee_id: 5001, full_name: 'Тестов Т. Т.', field_name: 'inn', status: 'open', document_id: 42, ocr_value_enc: null }),
  query: s.query,
  execute: vi.fn().mockResolvedValue(0),
  withTransaction: vi.fn(),
  getPool: vi.fn(),
  pool: vi.fn(),
}));

vi.mock('../services/access-control.service.js', () => ({
  resolveEffectivePageAccess: vi.fn(async (_req: unknown, page: string, action: 'view' | 'edit') => {
    const mode: Mode = s.matrix[page] ?? 'none';
    return action === 'view' ? mode !== 'none' : mode === 'edit';
  }),
  hasPageView: vi.fn(async () => true),
}));

vi.mock('../services/hr-feature-flag.service.js', () => ({
  HR_PROFILES_ENABLED_KEY: 'hr_profiles_enabled',
  isHrProfilesEnabled: vi.fn(async () => true),
  requireHrEnabled: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
}));

vi.mock('../services/data-scope.service.js', () => ({
  // Общий скоуп пускает к обоим сотрудникам — как у табельщицы на проде.
  canAccessEmployeeInScope: vi.fn(async () => true),
  canWriteEmployeeInScope: s.canWriteEmployeeInScope,
  resolveAccessibleEmployeeIds: vi.fn(async () => new Set([ROSTER_EMPLOYEE, OBJECT_ONLY_EMPLOYEE])),
  resolveAccessibleDepartmentIds: vi.fn(async () => []),
  resolveScopedDepartmentId: vi.fn(async () => null),
  resolveWritableScopedDepartmentId: vi.fn(async () => null),
}));

vi.mock('../services/employee-scope-filter.service.js', () => ({
  canSeeEmployeeInStaffList: vi.fn(async (_req: unknown, employeeId: number) => employeeId === ROSTER_EMPLOYEE),
  resolveStaffRosterEmployeeIds: vi.fn(async () => new Set([ROSTER_EMPLOYEE])),
  resolveEmployeeListReadScope: vi.fn(async () => ({ scope: 'department', globalRead: false })),
  resolveEmployeeListScopeFilter: vi.fn(),
  filterEmployeeIdsByReadScope: vi.fn(async () => []),
}));

vi.mock('../services/audit.service.js', () => ({
  auditService: { logFromRequest: s.audit },
  AUDIT_ACTIONS: new Proxy({}, { get: (_t, k) => String(k) }),
}));

vi.mock('../services/hr-documents.service.js', () => ({
  HrDocumentError: class extends Error { constructor(msg: string, readonly status = 400) { super(msg); } },
  HR_FILE_MAX_BYTES: 20 * 1024 * 1024,
  RECOGNIZABLE_MIME: new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),
  uploadHrDocument: s.uploadHrDocument,
  loadHrDocument: vi.fn(async () => s.doc),
  loadDecryptedBytes: vi.fn(async () => Buffer.from('scan')),
  softDeleteHrDocument: s.softDeleteHrDocument,
  resolveHrDocumentOwner: vi.fn(async () => s.owner),
  listEmployeeHrDocumentRows: vi.fn(async () => []),
  listDraftHrDocumentRows: vi.fn(async () => []),
  groupIntoSlots: vi.fn(() => []),
  countCompleteness: vi.fn(() => ({ required: 0, filled: 0, total: 0 })),
  toPublic: vi.fn((row: Record<string, unknown>) => ({ ...row, ocr_supported: true })),
  readRecognitionResult: vi.fn(() => null),
}));

vi.mock('../services/hr-ocr/worker.js', () => ({
  enqueueHrOcr: s.enqueueHrOcr,
  startHrOcrWorker: vi.fn(),
  stopHrOcrWorker: vi.fn(),
}));

vi.mock('../services/hr-draft.service.js', () => ({
  loadDraft: vi.fn(async () => (s.draftCreatedBy ? { id: 'draft-1', created_by: s.draftCreatedBy, state: 'draft' } : null)),
  listMyDrafts: vi.fn(async () => []),
  createDraft: vi.fn(async () => ({ id: 'draft-1' })),
}));

vi.mock('../services/hr-profile.service.js', () => ({
  IdentityClaimConflictError: class extends Error {},
  loadProfileRow: vi.fn(async () => (s.profileExists ? { employee_id: 5001, passport_type: 'russian' } : null)),
  buildProfileView: s.buildProfileView,
  createProfile: s.createProfile,
  updateProfile: vi.fn(async () => ({ changedFields: [], zupReset: false })),
  applyProfilePatch: vi.fn(),
  listHistory: vi.fn(async () => []),
  listCitizenships: vi.fn(async () => []),
  findDuplicates: vi.fn(async () => []),
  markZupExported: vi.fn(),
  setZupUploaded: vi.fn(),
  recordHistory: vi.fn(),
  rowToPlainFields: vi.fn(() => ({})),
}));

const app = (await import('../app.js')).default;

const token = (roleCode: string, userId: string): string => jwt.sign(
  {
    sub: userId,
    email: `${userId}@example.com`,
    system_role_id: 'role-uuid',
    role_code: roleCode,
    is_admin: false,
    employee_variant: 'office',
    employee_id: 577,
    department_id: null,
    is_approved: true,
    two_factor_enabled: false,
    two_factor_verified: true,
  },
  process.env.JWT_SECRET!,
  { expiresIn: '1h' },
);

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
const call = (method: Method, url: string, as: { role: string; user: string }): request.Test =>
  (request(app) as unknown as Record<Method, (u: string) => request.Test>)[method](url)
    .set('Authorization', `Bearer ${token(as.role, as.user)}`);

const TIMEKEEPER = { role: 'timekeeper', user: TIMEKEEPER_USER };
const HR = { role: 'hr', user: 'hr-user' };

const auditActions = (): string[] => s.audit.mock.calls.map(c => String(c[2]));

const makeDoc = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 42,
  employee_id: ROSTER_EMPLOYEE,
  category: 'hr_passport',
  file_name: 'passport.jpg',
  mime_type: 'image/jpeg',
  file_size: 1024,
  r2_key: 'hr/42.bin',
  uploaded_by: 'hr-user',
  deleted_at: null,
  recognition_status: 'done',
  ...over,
});

const d = process.env.CODEX_SANDBOX ? describe.skip : describe;

beforeEach(() => {
  s.matrix = { '/staff-control/hr-profiles': 'view', '/staff-control/hr-documents': 'edit' };
  s.profileExists = true;
  s.created = true;
  s.doc = makeDoc();
  s.owner = { employeeId: null, draftId: null };
  s.draftCreatedBy = null;
  s.query.mockReset().mockResolvedValue([]);
  s.audit.mockReset().mockResolvedValue(undefined);
  s.buildProfileView.mockReset().mockImplementation(async (_row: unknown, opts: { unmask: boolean }) => ({ unmask: opts.unmask, document_slots: [] }));
  s.createProfile.mockReset().mockImplementation(async () => ({ changedFields: [], zupReset: false, created: s.created }));
  s.uploadHrDocument.mockReset().mockImplementation(async () => makeDoc({ uploaded_by: TIMEKEEPER_USER }));
  s.softDeleteHrDocument.mockReset().mockResolvedValue(undefined);
  s.enqueueHrOcr.mockReset().mockResolvedValue(undefined);
  s.canWriteEmployeeInScope.mockReset().mockResolvedValue(true);
});

d('ключ документов: полные номера', () => {
  it('сотрудник из списка кадров → номера полные, показ в аудите', async () => {
    const res = await call('get', `/api/hr-profiles/${ROSTER_EMPLOYEE}/sensitive`, TIMEKEEPER);
    expect(res.status).toBe(200);
    expect(res.body.data.unmask).toBe(true);
    expect(auditActions()).toContain('HR_PROFILE_VIEW_SENSITIVE');
  });

  it('человек её объекта вне папок → 403, в аудит ничего', async () => {
    const res = await call('get', `/api/hr-profiles/${OBJECT_ONLY_EMPLOYEE}/sensitive`, TIMEKEEPER);
    expect(res.status).toBe(403);
    expect(s.audit).not.toHaveBeenCalled();
  });
});

d('ключ документов: просмотр и скачивание сканов', () => {
  it('чужой (загруженный кадрами) файл сотрудника из списка открывается', async () => {
    const res = await call('get', '/api/hr-profiles/documents/42/content', TIMEKEEPER);
    expect(res.status).toBe(200);
    expect(auditActions()).toEqual(['HR_FILE_VIEW']);
  });

  it('и скачивается — отдельным событием аудита', async () => {
    const res = await call('get', '/api/hr-profiles/documents/42/content?disposition=attachment', TIMEKEEPER);
    expect(res.status).toBe(200);
    expect(auditActions()).toEqual(['HR_FILE_DOWNLOAD']);
  });

  it('файл человека вне списка → 403', async () => {
    s.doc = makeDoc({ employee_id: OBJECT_ONLY_EMPLOYEE });
    const res = await call('get', '/api/hr-profiles/documents/42/content', TIMEKEEPER);
    expect(res.status).toBe(403);
  });

  it('файл черновика мастера → 403, даже если черновик её собственный', async () => {
    s.doc = makeDoc({ employee_id: null, uploaded_by: TIMEKEEPER_USER });
    s.owner = { employeeId: null, draftId: 'draft-1' };
    s.draftCreatedBy = TIMEKEEPER_USER;
    const res = await call('get', '/api/hr-profiles/documents/42/content', TIMEKEEPER);
    expect(res.status).toBe(403);
  });
});

d('ключ документов: загрузка на распознавание', () => {
  const upload = (employeeId: number): request.Test => call('post', `/api/hr-profiles/${employeeId}/documents`, TIMEKEEPER)
    .field('type', 'passport')
    .attach('file', Buffer.from('jpeg-bytes'), { filename: 'passport.jpg', contentType: 'image/jpeg' });

  it('сотруднику из списка — загружается, скоуп записи не спрашиваем', async () => {
    const res = await upload(ROSTER_EMPLOYEE);
    expect(res.status).toBe(201);
    expect(s.uploadHrDocument).toHaveBeenCalledTimes(1);
    expect(s.uploadHrDocument.mock.calls[0][1]).toMatchObject({ uploadedBy: TIMEKEEPER_USER });
    expect(s.canWriteEmployeeInScope).not.toHaveBeenCalled();
  });

  it('человеку вне списка → 403', async () => {
    const res = await upload(OBJECT_ONLY_EMPLOYEE);
    expect(res.status).toBe(403);
    expect(s.uploadHrDocument).not.toHaveBeenCalled();
  });
});

d('ключ документов: «Завести реквизиты»', () => {
  it('реквизитов нет → создаётся ПУСТОЙ профиль: присланные поля игнорируются', async () => {
    s.profileExists = false;
    const res = await call('post', `/api/hr-profiles/${ROSTER_EMPLOYEE}`, TIMEKEEPER)
      .send({ inn: '500100732259', passport_number: '4510 123456' });
    expect(res.status).toBe(201);
    expect(s.createProfile).toHaveBeenCalledTimes(1);
    expect(s.createProfile.mock.calls[0][1]).toEqual({});
    expect(auditActions()).toEqual(['HR_PROFILE_CREATE']);
  });

  it('реквизиты уже есть → 409, поля не трогаются, в аудит ничего', async () => {
    s.created = false;
    const res = await call('post', `/api/hr-profiles/${ROSTER_EMPLOYEE}`, TIMEKEEPER)
      .send({ inn: '500100732259' });
    expect(res.status).toBe(409);
    expect(s.createProfile.mock.calls[0][1]).toEqual({});
    expect(s.audit).not.toHaveBeenCalled();
  });

  it('человеку вне списка → 403', async () => {
    const res = await call('post', `/api/hr-profiles/${OBJECT_ONLY_EMPLOYEE}`, TIMEKEEPER).send({});
    expect(res.status).toBe(403);
    expect(s.createProfile).not.toHaveBeenCalled();
  });

  it('пока реквизитов нет, карточка сообщает, что завести их можно', async () => {
    s.profileExists = false;
    const res = await call('get', `/api/hr-profiles/${ROSTER_EMPLOYEE}`, TIMEKEEPER);
    expect(res.status).toBe(404);
    expect(res.body.data.can_create).toBe(true);
  });

  it('без ключа документов — завести нельзя', async () => {
    s.profileExists = false;
    s.matrix = { '/staff-control/hr-profiles': 'view' };
    const res = await call('get', `/api/hr-profiles/${ROSTER_EMPLOYEE}`, TIMEKEEPER);
    expect(res.body.data.can_create).toBe(false);
  });
});

d('ключ документов: удаление и повторное распознавание — только свои файлы', () => {
  it.each([
    ['delete', '/api/hr-profiles/documents/42'],
    ['post', '/api/hr-profiles/documents/42/recognize'],
  ] as const)('свой файл: %s %s → 200', async (method, url) => {
    s.doc = makeDoc({ uploaded_by: TIMEKEEPER_USER });
    const res = await call(method, url, TIMEKEEPER);
    expect(res.status).toBe(200);
  });

  it.each([
    ['delete', '/api/hr-profiles/documents/42'],
    ['post', '/api/hr-profiles/documents/42/recognize'],
  ] as const)('файл, загруженный кадрами: %s %s → 403', async (method, url) => {
    const res = await call(method, url, TIMEKEEPER);
    expect(res.status).toBe(403);
    expect(s.softDeleteHrDocument).not.toHaveBeenCalled();
    expect(s.enqueueHrOcr).not.toHaveBeenCalled();
  });

  it('свой офисный файл: распознавание → 400, в очередь не ставится', async () => {
    s.doc = makeDoc({
      uploaded_by: TIMEKEEPER_USER,
      file_name: 'реквизиты.docx',
      mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    const res = await call('post', '/api/hr-profiles/documents/42/recognize', TIMEKEEPER);
    expect(res.status).toBe(400);
    expect(s.enqueueHrOcr).not.toHaveBeenCalled();
  });

  it('свой файл у человека вне списка → 403', async () => {
    s.doc = makeDoc({ uploaded_by: TIMEKEEPER_USER, employee_id: OBJECT_ONLY_EMPLOYEE });
    const res = await call('delete', '/api/hr-profiles/documents/42', TIMEKEEPER);
    expect(res.status).toBe(403);
  });
});

d('ключ документов НЕ даёт правку', () => {
  it.each([
    ['put', `/api/hr-profiles/${ROSTER_EMPLOYEE}`],
    ['patch', `/api/hr-profiles/${ROSTER_EMPLOYEE}/zup`],
    ['post', '/api/hr-profiles/zup/bulk'],
    ['get', '/api/hr-profiles/export/zup'],
    ['get', '/api/hr-profiles/duplicates'],
    ['post', '/api/hr-profiles/ocr-conflicts/7/apply'],
    ['post', '/api/hr-profiles/ocr-conflicts/7/dismiss'],
    ['post', '/api/hr-profiles/drafts'],
    ['get', '/api/hr-profiles/drafts'],
    ['post', '/api/hr-profiles/drafts/draft-1/documents'],
    ['post', '/api/hr-profiles/drafts/draft-1/attach'],
  ] as const)('%s %s → 403', async (method, url) => {
    const res = await call(method, url, TIMEKEEPER);
    expect(res.status).toBe(403);
  });
});

d('без ключа документов (только просмотр реквизитов) всё закрыто', () => {
  beforeEach(() => { s.matrix = { '/staff-control/hr-profiles': 'view' }; });

  it.each([
    ['get', `/api/hr-profiles/${ROSTER_EMPLOYEE}/sensitive`],
    ['get', '/api/hr-profiles/documents/42/content'],
    ['post', `/api/hr-profiles/${ROSTER_EMPLOYEE}/documents`],
    ['post', `/api/hr-profiles/${ROSTER_EMPLOYEE}`],
    ['delete', '/api/hr-profiles/documents/42'],
    ['post', '/api/hr-profiles/documents/42/recognize'],
  ] as const)('%s %s → 403', async (method, url) => {
    s.doc = makeDoc({ uploaded_by: TIMEKEEPER_USER });
    const res = await call(method, url, TIMEKEEPER);
    expect(res.status).toBe(403);
  });
});

d('ключ документов без просмотра реквизитов не работает', () => {
  it.each([
    ['get', `/api/hr-profiles/${ROSTER_EMPLOYEE}/sensitive`],
    ['get', '/api/hr-profiles/documents/42/content'],
    ['post', `/api/hr-profiles/${ROSTER_EMPLOYEE}`],
  ] as const)('%s %s → 403', async (method, url) => {
    s.matrix = { '/staff-control/hr-documents': 'edit' };
    const res = await call(method, url, TIMEKEEPER);
    expect(res.status).toBe(403);
  });
});

d('чтение реквизитов табельщицей — по списку кадров', () => {
  it.each([
    ['', 200],
    ['/history', 200],
    ['/ocr-conflicts', 200],
    ['/documents', 200],
  ] as const)('сотрудник из списка: GET /:id%s → %i', async (suffix, status) => {
    const res = await call('get', `/api/hr-profiles/${ROSTER_EMPLOYEE}${suffix}`, TIMEKEEPER);
    expect(res.status).toBe(status);
  });

  it.each(['', '/history', '/ocr-conflicts', '/documents'])('человек её объекта вне папок: GET /:id%s → 403', async (suffix) => {
    const res = await call('get', `/api/hr-profiles/${OBJECT_ONLY_EMPLOYEE}${suffix}`, TIMEKEEPER);
    expect(res.status).toBe(403);
  });

  it('реестр реквизитов ограничен списком кадров, а не общим скоупом', async () => {
    const res = await call('get', '/api/hr-profiles', TIMEKEEPER);
    expect(res.status).toBe(200);
    const registry = s.query.mock.calls.find(c => String(c[0]).includes('FROM employee_hr_profiles p'));
    expect(registry?.[1]).toContainEqual([ROSTER_EMPLOYEE]);
    expect(JSON.stringify(registry?.[1])).not.toContain(String(OBJECT_ONLY_EMPLOYEE));
  });

  it('поиск сотрудников — тоже', async () => {
    const res = await call('get', `/api/hr-profiles/employees/search?q=${encodeURIComponent('Тест')}`, TIMEKEEPER);
    expect(res.status).toBe(200);
    const search = s.query.mock.calls.find(c => String(c[0]).includes('e.full_name ILIKE $1'));
    expect(search?.[1]).toContainEqual([ROSTER_EMPLOYEE]);
    expect(JSON.stringify(search?.[1])).not.toContain(String(OBJECT_ONLY_EMPLOYEE));
  });

  it('у кадровика реестр по-прежнему по общему скоупу', async () => {
    s.matrix = { '/staff-control/hr-profiles': 'edit' };
    await call('get', '/api/hr-profiles', HR);
    const registry = s.query.mock.calls.find(c => String(c[0]).includes('FROM employee_hr_profiles p'));
    expect(registry?.[1]).toContainEqual([ROSTER_EMPLOYEE, OBJECT_ONLY_EMPLOYEE]);
  });
});

d('кадровик с правкой реквизитов — прежнее поведение', () => {
  beforeEach(() => { s.matrix = { '/staff-control/hr-profiles': 'edit' }; });

  it('загрузка идёт по скоупу записи', async () => {
    const res = await call('post', `/api/hr-profiles/${OBJECT_ONLY_EMPLOYEE}/documents`, HR)
      .field('type', 'passport')
      .attach('file', Buffer.from('jpeg-bytes'), { filename: 'passport.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(201);
    expect(s.canWriteEmployeeInScope).toHaveBeenCalled();
  });

  it('вне скоупа записи загрузка → 403', async () => {
    s.canWriteEmployeeInScope.mockResolvedValue(false);
    const res = await call('post', `/api/hr-profiles/${ROSTER_EMPLOYEE}/documents`, HR)
      .field('type', 'passport')
      .attach('file', Buffer.from('jpeg-bytes'), { filename: 'passport.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(403);
  });

  it('создание с полями: тело уходит в профиль, повтор — 200, а не 409', async () => {
    s.created = false;
    const res = await call('post', `/api/hr-profiles/${ROSTER_EMPLOYEE}`, HR).send({ phone: '+7 900 000-00-00' });
    expect(res.status).toBe(200);
    expect(s.createProfile.mock.calls[0][1]).toEqual({ phone: '+7 900 000-00-00' });
    expect(res.body.data.unmask).toBe(true);
    expect(auditActions()).toEqual(['HR_PROFILE_UPDATE']);
  });

  it('удаляет и распознаёт чужие файлы', async () => {
    expect((await call('delete', '/api/hr-profiles/documents/42', HR)).status).toBe(200);
    expect((await call('post', '/api/hr-profiles/documents/42/recognize', HR)).status).toBe(200);
  });

  it('файл своего черновика мастера открывается', async () => {
    s.doc = makeDoc({ employee_id: null });
    s.owner = { employeeId: null, draftId: 'draft-1' };
    s.draftCreatedBy = HR.user;
    const res = await call('get', '/api/hr-profiles/documents/42/content', HR);
    expect(res.status).toBe(200);
  });

  it('файл чужого черновика — нет', async () => {
    s.doc = makeDoc({ employee_id: null });
    s.owner = { employeeId: null, draftId: 'draft-1' };
    s.draftCreatedBy = 'someone-else';
    const res = await call('get', '/api/hr-profiles/documents/42/content', HR);
    expect(res.status).toBe(403);
  });
});
