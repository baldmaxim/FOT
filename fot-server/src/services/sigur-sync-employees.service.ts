import { sigurService } from './sigur.service.js';
import { query, queryOne, execute, withTransaction } from '../config/postgres.js';
import { parseFIO, normalizeFullName } from '../utils/fio.utils.js';
import {
  getPositionsRaw,
  getWhitelistedDepartmentIdsCached,
  logSampleAndWarn,
  normalizeEmployee,
  type ISyncContext,
} from './sigur-sync-shared.js';
import { employeeChangesService } from './employee-changes.service.js';
import { formatDateShift } from './timesheet-department-assignments.service.js';
import { moscowTodayIso } from '../utils/date.utils.js';
import { employeeCache } from './employee-cache.service.js';
import { ensureLocalArchiveDepartment, getKnownArchiveDepartment } from './employee-archive-department.service.js';
import { invalidatePresencePollingEmployeeCache } from './presence-polling-cache.service.js';
import { batchMoveSigurEmployees } from './sigur-live-employees-crud.service.js';
import { settingsService } from './settings.service.js';
import { upsertTechnicalDepartmentAccess } from './employee-department-access.service.js';
import { invalidateTimekeeperScopeCache } from './timekeeper-scope.service.js';
import { auditService } from './audit.service.js';

// ─── Хелперы защиты от «осиротения» (B′) ───

/**
 * true, если `newDeptId` является ПРЕДКОМ `currentDeptId` в дереве отделов
 * (т.е. перенос — это подъём к корню/родителю). Такой перенос из Sigur почти
 * всегда артефакт удаления/пересоздания папки, а не настоящий перевод.
 * Защита от циклов в parent_id — ограничение глубины обхода.
 */
export function isAncestorDepartment(
  newDeptId: string,
  currentDeptId: string | null | undefined,
  parentById: Map<string, string | null>,
): boolean {
  if (!currentDeptId || newDeptId === currentDeptId) return false;
  let cursor = parentById.get(currentDeptId) ?? null;
  for (let depth = 0; depth < 64 && cursor; depth++) {
    if (cursor === newDeptId) return true;
    cursor = parentById.get(cursor) ?? null;
  }
  return false;
}

// ─── Решение по смене отдела на фазе сохранения (защита от гонки с увольнением) ───

export type TDeptSyncAction = 'apply' | 'noop' | 'snapshot-only' | 'defer' | 'skip-local-dismissal' | 'skip-fired';

export interface IDeptSyncFreshState {
  org_department_id: string | null;
  employment_status: string;
  dismissal_date: string | null;
  dismissal_apply_started_at: string | null;
  /** Назначения сотрудника в ЦЕЛЕВОЙ отдел, ещё актуальные (effective_to IS NULL или >= today). */
  target_assignments: Array<{ effective_from: string; effective_to: string | null }>;
}

/**
 * Чистая функция решения: что делать с обнаруженным расхождением отдела.
 *
 * Гонка «увольнение ↔ синк» (кейс Сафарова 1623, 31.07.2026): in-memory снимок
 * `dbEmpById` грузится в начале долгого прогона и устаревает — увольнение,
 * применённое планировщиком в 23:00+, синк принимал за неучтённый перенос и
 * оформлял его «сегодняшним днём»: резал реальный отдел до D-1 и вставлял дубль
 * «Уволенные [D..D]» рядом с правильным «[D+1..∞]» от увольнения. Решение
 * принимается по СВЕЖИМ данным БД, прочитанным непосредственно перед записью.
 *
 * - `skip-local-dismissal` — только для перехода в архив (`isDismissalDept`),
 *   когда увольнением владеет lifecycle/scheduler: активная заявка (`active` +
 *   `dismissal_date` ЛЮБОЙ даты — просроченную после простоя сервера обязан
 *   применить планировщик именно той датой), claim `dismissal_apply_started_at`
 *   или уже созданное будущее назначение в архив. Гейт по целевому отделу
 *   обязателен: claim не очищается после успешного увольнения, без гейта
 *   блокировались бы возврат из архива и обычный перевод с будущим увольнением.
 * - `skip-fired` — сотрудник уже уволен (fresh-статус не `active`), а Sigur всё ещё
 *   отдаёт его в рабочем отделе. Синк не возвращает уволенного в строй: ни отдел,
 *   ни должность, ни lifecycle-поля не меняются (инцидент 10–13.08.2026 — увольнения
 *   планировщика откатывались ближайшим синком). Возврат в строй — только явный rehire.
 * - `noop` — снапшот уже в целевом отделе.
 * - `snapshot-only` — назначение в целевой отдел уже активно сегодня, отстал только
 *   снапшот `employees.org_department_id`: обновить его, историю не трогать.
 * - `defer` — назначение в целевой отдел начинается в будущем: в этот тик ничего
 *   не менять (когда оно вступит в силу, срезка станет `snapshot-only`).
 * - `apply` — настоящий внешний перенос через Sigur, полное старое поведение.
 */
export function decideDeptSyncAction(
  fresh: IDeptSyncFreshState,
  nextDeptId: string,
  isDismissalDept: boolean,
  todayIso: string,
): TDeptSyncAction {
  if (isDismissalDept) {
    const localDismissalPending = fresh.employment_status === 'active' && fresh.dismissal_date != null;
    const claimed = fresh.dismissal_apply_started_at != null;
    const archiveScheduled = fresh.target_assignments.some(a => a.effective_from > todayIso);
    if (localDismissalPending || claimed || archiveScheduled) return 'skip-local-dismissal';
  }
  // Уволенного синк не двигает вообще — независимо от того, что показывает Sigur.
  if (fresh.employment_status !== 'active') return 'skip-fired';
  if (fresh.org_department_id === nextDeptId) return 'noop';
  const activeToday = fresh.target_assignments.some(
    a => a.effective_from <= todayIso && (a.effective_to == null || a.effective_to >= todayIso),
  );
  if (activeToday) return 'snapshot-only';
  const scheduledFuture = fresh.target_assignments.some(a => a.effective_from > todayIso);
  if (scheduledFuture) return 'defer';
  return 'apply';
}

/** Авто-поля увольнения, проставляемые на этапе подготовки update по stale-снимку. */
const DISMISSAL_AUTO_FIELDS = [
  'employment_status',
  'dismissal_date',
  'excluded_from_timesheet',
  'excluded_from_timesheet_date',
] as const;

/**
 * Чистит `u.fields` по принятому решению (мутирует объект).
 *
 * - Авто-поля увольнения снимаются для ЛЮБОГО не-apply перехода в архив (иначе
 *   `defer` не менял бы историю, но всё равно пометил бы активного сотрудника
 *   уволенным сегодняшней датой), а также когда fresh-статус уже не `active`
 *   (увольнение применено — его dismissal_date авторитетен, не затирать).
 * - `org_department_id` остаётся только при `snapshot-only` (прямой UPDATE ниже
 *   подтянет отставший снапшот); при `apply` историю и снапшот пишет
 *   changeDepartment, при остальных решениях менять снапшот нельзя.
 * - При `skip-fired` дополнительно снимаются `position_id` и авто-поля увольнения
 *   (независимо от `isDismissalDept`): уволенному синк не меняет ни отдел, ни
 *   должность, ни статус.
 * - Несвязанные обновления (ФИО, табельный номер и т.п.) не трогаются.
 */
export function cleanUpdateFieldsForAction(
  fields: Record<string, unknown>,
  action: TDeptSyncAction,
  isDismissalDept: boolean,
  freshEmploymentStatus: string | null,
): void {
  const dropDismissalAuto = action === 'skip-fired'
    || (isDismissalDept && (action !== 'apply' || freshEmploymentStatus !== 'active'));
  if (dropDismissalAuto) {
    for (const key of DISMISSAL_AUTO_FIELDS) delete fields[key];
  }
  if (action !== 'snapshot-only') {
    delete fields.org_department_id;
  }
  if (action === 'skip-fired') {
    delete fields.position_id;
  }
}

// ─── Типы результатов ───

export interface ISeedPositionsResult {
  created: number;
  skipped: number;
  total: number;
}

export interface ISyncPositionsFromSigurResult {
  imported: number;
  updated: number;
  skipped: number;
  total: number;
  errors: string[];
}

export interface IUnmatchedSigurEmployee {
  sigurId: number | undefined;
  name: string;
  departmentName: string;
  positionName: string;
  orgDepartmentId: string | null;
  positionId: string | null;
}

export interface ISyncEmployeesResult {
  imported: number;
  updated: number;
  skipped: number;
  total: number;
  errors: string[];
  unmatched: IUnmatchedSigurEmployee[];
  auto_fired: number;
  /** Уволенных в ФОТ, которых Sigur отдал в рабочем отделе (обнаружено за прогон). */
  fired_mismatch_detected: number;
  /** Из них осталось нерешёнными после штатного переноса fired → архив Sigur. */
  fired_mismatch_unresolved: number;
}

// ─── Защита авто-fire от ложных срабатываний ───

export interface IAutoFireSafetyOptions {
  /** Минимальный порог по абсолютному количеству, переопределяется env SIGUR_AUTOFIRE_MAX. По умолчанию 20. */
  absoluteLimit?: number;
  /** Доля активных, выше которой массовый авто-fire считается аномалией. По умолчанию 0.05 (5%). */
  relativeLimitRatio?: number;
  /** Пороговая доля «выгрузка / активные»: ниже неё считаем выгрузку усечённой. По умолчанию 0.5 (50%). */
  truncationRatio?: number;
}

export interface IAutoFireDecision {
  shouldSkip: boolean;
  reason: string | null;
  limit: number;
}

/**
 * Решает, безопасно ли применить авто-fire к найденным «отсутствующим» сотрудникам.
 * Чистая функция — тестируется без моков supabase/sigur.
 */
export function evaluateAutoFireSafety(
  activeWithSigur: number,
  sigurCount: number,
  toFireCount: number,
  opts: IAutoFireSafetyOptions = {},
): IAutoFireDecision {
  const absLimit = Math.max(1, opts.absoluteLimit ?? 20);
  const relRatio = opts.relativeLimitRatio ?? 0.05;
  const truncRatio = opts.truncationRatio ?? 0.5;
  const limit = Math.max(absLimit, Math.ceil(activeWithSigur * relRatio));

  if (activeWithSigur > 0 && sigurCount < activeWithSigur * truncRatio) {
    return {
      shouldSkip: true,
      reason: `auto-fire skipped: sigur returned ${sigurCount} but db has ${activeWithSigur} active — looks truncated`,
      limit,
    };
  }
  if (toFireCount > limit) {
    return {
      shouldSkip: true,
      reason: `auto-fire skipped: would fire ${toFireCount} employees, exceeds limit ${limit}`,
      limit,
    };
  }
  return { shouldSkip: false, reason: null, limit };
}

// ─── Чистые функции синхронизации ───

export async function syncPositionsFromSigurLogic(
  connection?: 'external' | 'internal',
  context?: ISyncContext,
): Promise<ISyncPositionsFromSigurResult> {
  if (!(await sigurService.isConfigured())) throw new Error('Sigur не настроен');

  const sigurPositions = await getPositionsRaw(connection, context);
  if (!sigurPositions || sigurPositions.length === 0) {
    return { imported: 0, updated: 0, skipped: 0, total: 0, errors: [] };
  }

  console.log(`[syncPositionsFromSigur] got ${sigurPositions.length} positions from Sigur`);

  const existingPositions = await query<{ id: string; sigur_position_id: number | null; name: string | null }>(
    'SELECT id, sigur_position_id, name FROM positions',
  );

  const sigurIdToDbId = new Map<number, string>();
  for (const p of existingPositions || []) {
    if (p.sigur_position_id != null) {
      sigurIdToDbId.set(p.sigur_position_id, p.id);
    }
  }

  let imported = 0;
  let updated = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const pos of sigurPositions) {
    const name = (pos.name as string) || '';
    const sigurId = pos.id as number;

    if (!name.trim()) { skipped++; continue; }

    if (sigurIdToDbId.has(sigurId)) {
      const dbId = sigurIdToDbId.get(sigurId)!;
      try {
        await execute(
          'UPDATE positions SET name = $1 WHERE id = $2',
          [name.trim(), dbId],
        );
        updated++;
      } catch (updateError) {
        errors.push(`update ${name}: ${(updateError as Error).message}`);
      }
    } else {
      try {
        await execute(
          `INSERT INTO positions (name, sigur_position_id, category) VALUES ($1, $2, 'other')`,
          [name.trim(), sigurId],
        );
        imported++;
      } catch (insertError) {
        errors.push(`insert ${name}: ${(insertError as Error).message}`);
      }
    }
  }

  console.log(`[syncPositionsFromSigur] done: ${imported} imported, ${updated} updated, ${skipped} skipped`);
  return { imported, updated, skipped, total: sigurPositions.length, errors };
}

export async function seedPositionsLogic(): Promise<ISeedPositionsResult> {
  const SEED_POSITIONS = [
    { name: 'Руководитель строительства', category: 'manager', grade: 50, sort_order: 1 },
    { name: 'Начальник участка', category: 'manager', grade: 40, sort_order: 2 },
    { name: 'Прораб', category: 'engineer', grade: 30, sort_order: 3 },
    { name: 'Бригадир', category: 'worker', grade: 20, sort_order: 4 },
    { name: 'Рабочий', category: 'worker', grade: 10, sort_order: 5 },
    { name: 'Инженер', category: 'engineer', grade: 25, sort_order: 6 },
    { name: 'Сотрудник', category: 'other', grade: 5, sort_order: 7 },
  ];

  const existing = await query<{ id: string; name: string | null }>(
    'SELECT id, name FROM positions',
  );

  const existingNames = new Set<string>();
  for (const pos of existing || []) {
    if (pos.name) {
      existingNames.add(pos.name.toLowerCase().trim());
    }
  }

  let created = 0;
  let skipped = 0;

  for (const pos of SEED_POSITIONS) {
    if (existingNames.has(pos.name.toLowerCase().trim())) {
      skipped++;
      continue;
    }

    try {
      await execute(
        `INSERT INTO positions (name, category, grade, sort_order) VALUES ($1, $2, $3, $4)`,
        [pos.name, pos.category, pos.grade, pos.sort_order],
      );
      created++;
    } catch (error) {
      console.error(`[seedPositions] error for "${pos.name}":`, (error as Error).message);
    }
  }

  console.log(`[seedPositions] done: ${created} created, ${skipped} skipped`);
  return { created, skipped, total: SEED_POSITIONS.length };
}

export async function syncEmployeesLogic(
  connection?: 'external' | 'internal',
  onProgress?: (data: Record<string, unknown>) => void,
  context?: ISyncContext,
  autoInsert = true,
): Promise<ISyncEmployeesResult> {
  if (!(await sigurService.isConfigured())) throw new Error('Sigur не настроен');

  const send = onProgress || (() => {});
  send({ type: 'employees_progress', phase: 'loading', current: 0, total: 0, percent: 0 });

  // Всегда загружаем полный список — чтобы обновлять отдел у существующих сотрудников
  // даже если они переехали за пределы whitelist-отделов
  const whitelist = await getWhitelistedDepartmentIdsCached(connection, context);
  if (whitelist) {
    console.log(`[syncEmployees] whitelist active: ${whitelist.size} subtree departments (applies to inserts and unmatched list)`);
  }
  const sigurEmployeesRaw = await sigurService.getEmployeesCached(connection);
  console.log('[syncEmployees] got', sigurEmployeesRaw.length, 'employees from Sigur');

  if (sigurEmployeesRaw.length === 0) {
    return {
      imported: 0, updated: 0, skipped: 0, total: 0, errors: [], unmatched: [], auto_fired: 0,
      fired_mismatch_detected: 0, fired_mismatch_unresolved: 0,
    };
  }

  logSampleAndWarn('syncEmployees', sigurEmployeesRaw[0], ['id', 'name', 'departmentId', 'positionId', 'position']);

  const sigurEmployees = sigurEmployeesRaw.map(normalizeEmployee);
  const skippedByWhitelist = 0;
  console.log(`[syncEmployees] employees to process: ${sigurEmployees.length}`);

  // Архивная папка Sigur — единый источник «уволен в Sigur».
  // Имена отделов больше не используются: regex /уволен/i ловил ложные совпадения.
  const archiveDepartmentId = (await settingsService.getSigurConnectionSettings()).archiveDepartmentId;
  if (!archiveDepartmentId) {
    console.warn('[syncEmployees] sigur_archive_department_id не задан — fire по архивной папке отключён');
  }

  // Глобальный поиск по sigur_employee_id
  const existingEmps: {
    id: number;
    sigur_employee_id: number;
    employment_status: string;
    department_locked: boolean;
    name_locked: boolean;
    org_department_id: string | null;
    position_id: string | null;
    tab_number: string | null;
    full_name: string | null;
    last_name: string | null;
    first_name: string | null;
    middle_name: string | null;
    dismissal_date: string | null;
  }[] = [];
  const EMP_PAGE = 1000;
  let empOffset = 0;
  while (true) {
    const existingEmpsPage = await query<typeof existingEmps[number]>(
      `SELECT id, sigur_employee_id, employment_status, department_locked, name_locked,
              org_department_id, position_id, tab_number, full_name, last_name, first_name, middle_name,
              dismissal_date
       FROM employees
       WHERE sigur_employee_id IS NOT NULL
       LIMIT ${EMP_PAGE} OFFSET ${empOffset}`,
    );
    if (!existingEmpsPage || existingEmpsPage.length === 0) break;
    existingEmps.push(...existingEmpsPage);
    if (existingEmpsPage.length < EMP_PAGE) break;
    empOffset += EMP_PAGE;
  }

  const sigurIdToDbId = new Map<number, number>();
  const firedSigurIds = new Set<number>();
  const dbEmpById = new Map<number, {
    org_department_id: string | null;
    position_id: string | null;
    tab_number: string | null;
    full_name: string | null;
    last_name: string | null;
    first_name: string | null;
    middle_name: string | null;
    department_locked: boolean;
    name_locked: boolean;
    employment_status: string;
    dismissal_date: string | null;
  }>();
  for (const e of existingEmps || []) {
    if (e.sigur_employee_id != null) {
      if (!sigurIdToDbId.has(e.sigur_employee_id)) {
        sigurIdToDbId.set(e.sigur_employee_id, e.id);
      }
      dbEmpById.set(e.id, {
        org_department_id: e.org_department_id,
        position_id: e.position_id,
        tab_number: e.tab_number,
        full_name: e.full_name,
        last_name: e.last_name,
        first_name: e.first_name,
        middle_name: e.middle_name,
        department_locked: e.department_locked,
        name_locked: e.name_locked,
        employment_status: e.employment_status,
        dismissal_date: e.dismissal_date ?? null,
      });
      if (e.employment_status === 'fired') firedSigurIds.add(e.sigur_employee_id);
    }
  }

  // Portal-only активные сотрудники (sigur_employee_id IS NULL) — чтобы новосозданный
  // в Sigur человек не породил дубль, если в БД уже есть активный portal-only с таким же ФИО
  // (например, после rehire с auto-detach).
  interface IPortalOnlyRow {
    id: number;
    full_name: string | null;
    last_name: string | null;
    first_name: string | null;
    middle_name: string | null;
    org_department_id: string | null;
    position_id: string | null;
    tab_number: string | null;
    department_locked: boolean;
    name_locked: boolean;
  }
  const portalOnlyEmps: IPortalOnlyRow[] = [];
  let portalOffset = 0;
  while (true) {
    const page = await query<IPortalOnlyRow>(
      `SELECT id, full_name, last_name, first_name, middle_name, org_department_id, position_id, tab_number, department_locked, name_locked
       FROM employees
       WHERE sigur_employee_id IS NULL AND employment_status = 'active'
       LIMIT ${EMP_PAGE} OFFSET ${portalOffset}`,
    );
    if (!page || page.length === 0) break;
    portalOnlyEmps.push(...page);
    if (page.length < EMP_PAGE) break;
    portalOffset += EMP_PAGE;
  }

  const portalOnlyByName = new Map<string, IPortalOnlyRow[]>();
  for (const e of portalOnlyEmps) {
    if (!e.full_name) continue;
    const key = normalizeFullName(e.full_name, { collapseYo: true });
    const arr = portalOnlyByName.get(key);
    if (arr) arr.push(e);
    else portalOnlyByName.set(key, [e]);
  }

  // ORDER BY is_active DESC → активная строка идёт первой и выигрывает (Map
  // ставим только если ключа ещё нет). Защита от привязки сотрудника к
  // осиротевшему is_active=false дубликату, если тот ещё не схлопнут
  // consolidateDuplicateDepartments (или до применения миграции 106).
  const dbDepartments = await query<{ id: string; sigur_department_id: number | null; name: string | null; is_active: boolean }>(
    'SELECT id, sigur_department_id, name, is_active FROM org_departments WHERE sigur_department_id IS NOT NULL ORDER BY is_active DESC, id ASC',
  );

  const sigurDeptToDbId = new Map<number, string>();
  const sigurDeptToName = new Map<number, string>();
  for (const d of dbDepartments || []) {
    if (d.sigur_department_id != null && !sigurDeptToDbId.has(d.sigur_department_id)) {
      sigurDeptToDbId.set(d.sigur_department_id, d.id);
      if (d.name) sigurDeptToName.set(d.sigur_department_id, d.name);
    }
  }

  // Локальный id архивного отдела «Уволенные» (для распознавания переходов увольнение/восстановление).
  // Фолбэк на локальную настройку `employees_archive_department_id` обязателен: пока
  // `sigur_archive_department_id` пустовал (до 14.08.2026), гард переходов в архив был
  // выключен целиком, и синк оформлял увольнения как обычные переводы.
  const archiveLocalDeptId = (archiveDepartmentId != null
    ? (sigurDeptToDbId.get(archiveDepartmentId) || null)
    : null)
    ?? (await getKnownArchiveDepartment(connection).catch(() => null))?.id
    ?? null;
  // Московская дата: UTC-срезка в окне 00:00–03:00 МСК давала вчерашнее число,
  // из-за чего переводы/увольнения ночного тика датировались вчерашним днём.
  const syncTodayIso = moscowTodayIso();

  // Карта parent_id отделов — для защиты от «осиротения» (B′): если Sigur вернул
  // сотруднику отдел-ПРЕДОК его текущего (подъём к корню/родителю — типичный
  // артефакт удаления/пересоздания папки в Sigur), перенос НЕ применяем.
  const deptParentById = new Map<string, string | null>();
  try {
    const deptRows = await query<{ id: string; parent_id: string | null }>(
      'SELECT id, parent_id FROM org_departments',
    );
    for (const d of deptRows || []) deptParentById.set(d.id, d.parent_id);
  } catch (deptTreeError) {
    console.warn('[syncEmployees] failed to load dept tree for ancestor guard:', (deptTreeError as Error).message);
  }
  const isAncestorOfCurrent = (newDeptId: string, currentDeptId: string | null | undefined): boolean =>
    isAncestorDepartment(newDeptId, currentDeptId, deptParentById);

  const dbPositions = await query<{ id: string; sigur_position_id: number | null }>(
    'SELECT id, sigur_position_id FROM positions WHERE sigur_position_id IS NOT NULL',
  );

  const sigurPosToDbId = new Map<number, string>();
  for (const p of dbPositions || []) {
    if (p.sigur_position_id != null) {
      sigurPosToDbId.set(p.sigur_position_id, p.id);
    }
  }

  // Карта имя должности → DB id (для текстового резолва)
  const allDbPositions = await query<{ id: string; name: string | null }>(
    'SELECT id, name FROM positions',
  );

  const posNameToDbId = new Map<string, string>();
  for (const p of allDbPositions || []) {
    if (p.name) {
      const name = p.name.toLowerCase().trim();
      if (name && !posNameToDbId.has(name)) posNameToDbId.set(name, p.id);
    }
  }

  let imported = 0;
  let updated = 0;
  let skipped = skippedByWhitelist;
  const errors: string[] = [];
  const inserts: Record<string, unknown>[] = [];
  const unmatchedList: IUnmatchedSigurEmployee[] = [];

  const totalEmployees = sigurEmployees.length;
  send({ type: 'employees_start', total: totalEmployees });

  // Сначала создаём недостающие должности (батчим по уникальным именам)
  const missingPositions = new Set<string>();
  for (const emp of sigurEmployees) {
    const sigurPosId = emp.positionId;
    const positionText = emp.position;
    if (!positionText) continue;
    let positionId: string | null = null;
    if (sigurPosId) positionId = sigurPosToDbId.get(sigurPosId) || null;
    if (!positionId) {
      const posKey = positionText.toLowerCase();
      if (!posNameToDbId.has(posKey)) missingPositions.add(positionText);
    }
  }

  if (missingPositions.size > 0) {
    send({ type: 'employees_progress', phase: 'positions', current: 0, total: totalEmployees, percent: 0 });
    const missingList = [...missingPositions];
    const lowerKeys = missingList.map(n => n.toLowerCase().trim());

    // Re-fetch: на positions(name) нет UNIQUE, поэтому ON CONFLICT бы упал
    // (FOT-SERVER-1S). Защищаемся от гонки с параллельной вставкой так же,
    // как делают остальные insert'ы в positions в кодовой базе — повторно
    // вычитываем существующие и не вставляем их повторно.
    const existing = await query<{ id: string; name: string | null }>(
      'SELECT id, name FROM positions WHERE lower(name) = ANY($1::text[])',
      [lowerKeys],
    );
    for (const p of existing || []) {
      if (p.name) {
        const k = p.name.toLowerCase().trim();
        if (k && !posNameToDbId.has(k)) posNameToDbId.set(k, p.id);
      }
    }

    const toInsert = missingList.filter(n => !posNameToDbId.has(n.toLowerCase().trim()));
    const POS_BATCH = 100;
    for (let i = 0; i < toInsert.length; i += POS_BATCH) {
      const batch = toInsert.slice(i, i + POS_BATCH);
      const params: unknown[] = [];
      const placeholders: string[] = [];
      for (const name of batch) {
        params.push(name, 'other');
        placeholders.push(`($${params.length - 1}, $${params.length})`);
      }
      const created = await query<{ id: string; name: string | null }>(
        `INSERT INTO positions (name, category) VALUES ${placeholders.join(', ')}
         RETURNING id, name`,
        params,
      );
      for (const p of created || []) {
        if (p.name) posNameToDbId.set(p.name.toLowerCase().trim(), p.id);
      }
    }
  }

  // Собираем обновления и вставки (без DB-запросов в цикле).
  // isDismissalDept — признак архивной папки ПО SIGUR department ID (не по archiveLocalDeptId:
  // локальный маппинг может отсутствовать, а распознавание увольнения обязано работать всегда).
  const updates: { id: number; fields: Record<string, unknown>; name: string; isDismissalDept: boolean }[] = [];
  // Уволенные в ФОТ, которых Sigur отдал в рабочем отделе (см. ветку ниже — реактивации нет).
  const firedMismatch: { employeeId: number; sigurId: number; name: string; sigurDeptName: string | null }[] = [];

  for (let empIdx = 0; empIdx < sigurEmployees.length; empIdx++) {
    const emp = sigurEmployees[empIdx];
    if (empIdx % 50 === 0) {
      send({ type: 'employees_progress', phase: 'matching', current: empIdx, total: totalEmployees, percent: Math.round((empIdx / totalEmployees) * 100) });
    }
    const fullName = emp.name;
    if (!fullName) { skipped++; continue; }

    const sigurEmpId = emp.id;
    const sigurDeptId = emp.departmentId;
    const sigurDeptName = sigurDeptId ? (sigurDeptToName.get(sigurDeptId) ?? null) : null;
    // Признак «уволен в Sigur» — точное совпадение с архивной папкой по id (settings.sigur_archive_department_id).
    // Раньше тут была regex /уволен/i по имени отдела, которая ловила ложные совпадения
    // (например, любой отдел с подстрокой «уволен» в названии).
    const orgDepartmentId = sigurDeptId ? sigurDeptToDbId.get(sigurDeptId) || null : null;
    // Вторая опора — локальный архивный отдел: при пустом `sigur_archive_department_id`
    // (как было до 14.08.2026) переход в «Уволенные» иначе считался обычным переводом,
    // и гард `skip-local-dismissal` не срабатывал.
    const isDismissalDept = (archiveDepartmentId != null
      && sigurDeptId != null
      && sigurDeptId === archiveDepartmentId)
      || (archiveLocalDeptId != null && orgDepartmentId === archiveLocalDeptId);
    const sigurPosId = emp.positionId;
    const positionText = emp.position;
    const tabNumber = emp.tabId ? emp.tabId.trim() : null;

    let positionId: string | null = null;
    if (sigurPosId) positionId = sigurPosToDbId.get(sigurPosId) || null;
    if (!positionId && positionText) {
      positionId = posNameToDbId.get(positionText.toLowerCase()) || null;
    }

    if (sigurEmpId && sigurIdToDbId.has(sigurEmpId)) {
      const dbId = sigurIdToDbId.get(sigurEmpId)!;
      const updateFields: Record<string, unknown> = {};
      const prev = dbEmpById.get(dbId);

      if (isDismissalDept) {
        // Сотрудник перемещён в «Уволенные» в Sigur → увольняем.
        // dismissal_date = today, чтобы сотрудник корректно отображался в табеле
        // (фильтр fired + cutoff по дате). Реальный отдел фиксируется ниже в батче.
        if (prev?.employment_status === 'active') {
          updateFields.employment_status = 'fired';
          updateFields.dismissal_date = syncTodayIso;
          updateFields.excluded_from_timesheet = true;
          updateFields.excluded_from_timesheet_date = formatDateShift(syncTodayIso, 1);
          console.log(`[syncEmployees] fire (dismissal dept): ${fullName} (sigurId=${sigurEmpId})`);
        }
      } else if (sigurEmpId && firedSigurIds.has(sigurEmpId)) {
        // Сотрудник fired в ФОТ, но Sigur отдаёт его в рабочем отделе. Раньше синк
        // «реактивировал» такого человека (снимал fired и обнулял dismissal_date) —
        // из-за этого увольнения планировщика откатывались ближайшим тиком
        // (инцидент 10–13.08.2026). Теперь только фиксируем расхождение: вернуть
        // в строй может лишь HR через явный rehire. Само расхождение штатно
        // устраняется ниже переносом fired → архивная папка Sigur.
        firedMismatch.push({
          employeeId: dbId,
          sigurId: sigurEmpId,
          name: fullName.trim(),
          sigurDeptName: sigurDeptName || null,
        });
        console.warn(
          `[syncEmployees] fired in FOT, working dept in Sigur — no reactivation: ${fullName} `
          + `(sigurId=${sigurEmpId}${sigurDeptName ? `, ${sigurDeptName}` : ''})`,
        );
      }

      if (orgDepartmentId) {
        const deptChanging = orgDepartmentId !== prev?.org_department_id;
        if (deptChanging && prev?.department_locked) {
          // Ручной override: отдел залочен — Sigur не меняет привязку (флаг не сбрасываем).
          console.warn(`[syncEmployees] skip dept change (locked): ${fullName} (sigurId=${sigurEmpId})`);
        } else if (deptChanging && isAncestorOfCurrent(orgDepartmentId, prev?.org_department_id)) {
          // B′: Sigur вернул отдел-предок текущего → осиротение (папка удалена/заменена,
          // человек всплыл к корню/родителю). Не переносим — это почти всегда артефакт.
          console.warn(
            `[syncEmployees] skip ancestor-demotion: ${fullName} (sigurId=${sigurEmpId}) `
            + `${prev?.org_department_id} → ${orgDepartmentId}${sigurDeptName ? ` (${sigurDeptName})` : ''}`,
          );
        } else {
          updateFields.org_department_id = orgDepartmentId;
        }
      }
      if (positionId) {
        updateFields.position_id = positionId;
      }
      const normalizedFullName = fullName.trim();
      const fio = parseFIO(normalizedFullName);
      if (
        prev
        && !prev.name_locked
        && (
          (prev.full_name || '') !== normalizedFullName
          || (prev.last_name || '') !== fio.lastName
          || (prev.first_name || null) !== (fio.firstName || null)
          || (prev.middle_name || null) !== (fio.middleName || null)
        )
      ) {
        updateFields.full_name = normalizedFullName;
        updateFields.last_name = fio.lastName;
        updateFields.first_name = fio.firstName || null;
        updateFields.middle_name = fio.middleName || null;
      }
      if ((prev?.tab_number || null) !== tabNumber) {
        updateFields.tab_number = tabNumber;
      }
      // department_locked НЕ сбрасываем при синке: это ручной override «Sigur не
      // меняет отдел» (см. skip dept change (locked) выше). Снимается только вручную.

      if (Object.keys(updateFields).length > 0) {
        updates.push({ id: dbId, fields: updateFields, name: fullName, isDismissalDept });
      } else {
        skipped++;
      }
      continue;
    }

    if (autoInsert) {
      // Whitelist ограничивает только вставку новых сотрудников, не обновление существующих.
      // Вставляем только сотрудников из реально выбранных для sync отделов.
      if (isDismissalDept) { skipped++; continue; }
      if (whitelist && (sigurDeptId == null || !whitelist.has(sigurDeptId))) {
        const deptName = (sigurDeptId ? sigurDeptToName.get(sigurDeptId) : null) || `sigurDeptId=${sigurDeptId ?? 'null'}`;
        console.log(`[syncEmployees] skip insert (whitelist): ${fullName} | dept: ${deptName}`);
        skipped++;
        continue;
      }

      // Защита от дублей: если в БД уже есть активный portal-only сотрудник с таким же ФИО
      // (например, восстановленный через rehire с auto-detach), привязываем нового Sigur-сотрудника
      // к существующей портальной записи вместо создания новой.
      const nameKey = normalizeFullName(fullName, { collapseYo: true });
      const portalMatches = portalOnlyByName.get(nameKey);
      if (portalMatches && portalMatches.length === 1 && sigurEmpId) {
        const match = portalMatches[0];
        const fio = parseFIO(fullName);
        const normalizedFullName = fullName.trim();
        const linkFields: Record<string, unknown> = {
          sigur_employee_id: sigurEmpId,
          department_locked: false,
          excluded_from_timesheet: false,
          excluded_from_timesheet_date: null,
        };
        if (orgDepartmentId) linkFields.org_department_id = orgDepartmentId;
        if (positionId) linkFields.position_id = positionId;
        if (tabNumber !== (match.tab_number || null)) linkFields.tab_number = tabNumber;
        if (!match.name_locked && (match.full_name || '') !== normalizedFullName) {
          linkFields.full_name = normalizedFullName;
          linkFields.last_name = fio.lastName;
          linkFields.first_name = fio.firstName || null;
          linkFields.middle_name = fio.middleName || null;
        }
        // Ветка недостижима для архивной папки (isDismissalDept отсёкся выше continue'ом).
        updates.push({ id: match.id, fields: linkFields, name: fullName, isDismissalDept: false });
        // dbEmpById нужен для корректной обработки в batch ниже (changeDepartment / changePosition)
        dbEmpById.set(match.id, {
          org_department_id: match.org_department_id,
          position_id: match.position_id,
          tab_number: match.tab_number,
          full_name: match.full_name,
          last_name: match.last_name,
          first_name: match.first_name,
          middle_name: match.middle_name,
          department_locked: match.department_locked,
          name_locked: match.name_locked,
          employment_status: 'active',
          dismissal_date: null,
        });
        sigurIdToDbId.set(sigurEmpId, match.id);
        portalOnlyByName.delete(nameKey);
        console.log(`[syncEmployees] auto-link portal-only: ${fullName} (id=${match.id}) ← sigurId=${sigurEmpId}`);
        continue;
      }
      if (portalMatches && portalMatches.length > 1) {
        // Неоднозначно — в unmatched, чтобы HR решил вручную через SigurMatchModal
        console.warn(`[syncEmployees] ambiguous portal-only match: ${fullName} (${portalMatches.length} candidates) — skip insert, add to unmatched`);
        unmatchedList.push({
          sigurId: sigurEmpId,
          name: fullName.trim(),
          departmentName: sigurDeptName || '',
          positionName: emp.position || '',
          orgDepartmentId: orgDepartmentId,
          positionId: positionId,
        });
        continue;
      }

      const fio = parseFIO(fullName);
      inserts.push({
        full_name: fullName.trim(),
        last_name: fio.lastName,
        first_name: fio.firstName || null,
        middle_name: fio.middleName || null,
        hire_date: new Date().toISOString().slice(0, 10),
        employment_status: 'active',
        is_archived: false,
        sigur_employee_id: sigurEmpId || null,
        org_department_id: orgDepartmentId,
        position_id: positionId,
        tab_number: tabNumber,
      });
    } else {
      // Для ручного sync-all показываем unmatched только по отделам,
      // которые реально входят в текущий whitelist синхронизации.
      if (whitelist && (sigurDeptId == null || !whitelist.has(sigurDeptId))) {
        skipped++;
        continue;
      }

      unmatchedList.push({
        sigurId: sigurEmpId,
        name: fullName.trim(),
        departmentName: (sigurDeptId ? sigurDeptToName.get(sigurDeptId) : null) || '',
        positionName: emp.position || '',
        orgDepartmentId: orgDepartmentId,
        positionId: positionId,
      });
    }
  }

  // Батчим обновления (параллельно по 20)
  console.log('[syncEmployees] prepared', updates.length, 'updates,', inserts.length, 'inserts,', unmatchedList.length, 'unmatched');
  send({ type: 'employees_progress', phase: 'saving', current: totalEmployees, total: totalEmployees, percent: 95 });

  const UPDATE_CONCURRENCY = 20;
  for (let i = 0; i < updates.length; i += UPDATE_CONCURRENCY) {
    const batch = updates.slice(i, i + UPDATE_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async u => {
        try {
          const prev = dbEmpById.get(u.id);
          const deptChanging = Boolean(
            u.fields.org_department_id && prev && u.fields.org_department_id !== prev.org_department_id,
          );
          const positionChanging = Boolean(
            u.fields.position_id && prev && u.fields.position_id !== prev.position_id,
          );

          // Fresh re-read: dbEmpById загружен в начале долгого прогона и мог устареть —
          // увольнение/перевод могли примениться, пока синк читал страницы Sigur.
          // Читаем при ЛЮБОМ lifecycle-изменении (отдел или должность): иначе у
          // уволенного с неизменившимся отделом синк всё равно менял бы должность.
          const freshEmp = (deptChanging || positionChanging)
            ? await queryOne<{
              org_department_id: string | null;
              employment_status: string;
              dismissal_date: string | null;
              dismissal_apply_started_at: string | null;
            }>(
              `SELECT org_department_id, employment_status,
                      dismissal_date::text AS dismissal_date,
                      dismissal_apply_started_at::text AS dismissal_apply_started_at
                 FROM employees WHERE id = $1`,
              [u.id],
            )
            : null;

          // Уволенного не трогаем и когда меняется только должность.
          if (!deptChanging && positionChanging && freshEmp && freshEmp.employment_status !== 'active') {
            cleanUpdateFieldsForAction(u.fields, 'skip-fired', u.isDismissalDept, freshEmp.employment_status);
            console.log(`[syncEmployees] position change skip-fired: ${u.name} (id=${u.id}) — сотрудник уволен`);
          }

          // Отдел изменился → пишем историю и синхронизируем назначения
          if (deptChanging && prev) {
            const nextDeptId = u.fields.org_department_id as string;

            const targetAssignments = freshEmp
              ? await query<{ effective_from: string; effective_to: string | null }>(
                  `SELECT effective_from::text AS effective_from, effective_to::text AS effective_to
                     FROM employee_assignments
                    WHERE employee_id = $1 AND org_department_id = $2
                      AND (effective_to IS NULL OR effective_to >= $3)`,
                  [u.id, nextDeptId, syncTodayIso],
                )
              : [];

            const action: TDeptSyncAction = freshEmp
              ? decideDeptSyncAction(
                  { ...freshEmp, target_assignments: targetAssignments || [] },
                  nextDeptId,
                  u.isDismissalDept,
                  syncTodayIso,
                )
              : 'apply';

            cleanUpdateFieldsForAction(u.fields, action, u.isDismissalDept, freshEmp?.employment_status ?? null);

            if (action !== 'apply') {
              // Должность уволенного/увольняемого тоже не трогаем: changePosition ниже
              // сработал бы по оставшемуся position_id.
              if (action === 'skip-local-dismissal') delete u.fields.position_id;
              console.log(
                `[syncEmployees] dept change ${action}: ${u.name} (id=${u.id}) → ${nextDeptId}`
                + (action === 'skip-local-dismissal' ? ' — увольнением владеет lifecycle/scheduler' : '')
                + (action === 'skip-fired' ? ' — сотрудник уволен, синк его не двигает' : ''),
              );
            } else {
              // Реальный отдел берём из fresh-строки (stale prev мог отстать).
              const freshDeptId = freshEmp?.org_department_id ?? prev.org_department_id;
              const toArchive = u.isDismissalDept || (archiveLocalDeptId != null && nextDeptId === archiveLocalDeptId);
              const fromArchive = archiveLocalDeptId != null && freshDeptId === archiveLocalDeptId;
              let changeResult: 'applied' | 'skipped' = 'applied';

              if (toArchive || fromArchive) {
                // Увольнение / восстановление через Sigur — ведём ПОЛНУЮ историю периодов
                // (forceHistory обходит freeze_history), без reopen-перезаписи, чтобы
                // реальный отдел не терялся. Переход датируется сегодняшним днём.
                changeResult = await employeeChangesService.changeDepartment(u.id, nextDeptId, {
                  reason: toArchive
                    ? 'Увольнение — перевод в папку "Уволенные"'
                    : 'Восстановление (синхронизация Sigur)',
                  lockDepartment: false,
                  effectiveDate: syncTodayIso,
                  forceHistory: true,
                  skipIfScheduledToTarget: true,
                });
                if (changeResult === 'applied' && toArchive && freshDeptId && freshDeptId !== archiveLocalDeptId) {
                  // Фиксируем событие увольнения с реальным отделом (для связности истории).
                  await execute(
                    `INSERT INTO employee_dismissal_events
                       (employee_id, dismissal_date, scheduled, from_department_id, created_by)
                     VALUES ($1, $2, false, $3, NULL)`,
                    [u.id, syncTodayIso, freshDeptId],
                  );
                }
              } else {
                // Обычный перевод между отделами — поведение как раньше (под freeze).
                // Защита от gap'а: если нет открытого назначения, но есть свежее закрытое
                // в нужном отделе — переоткрываем его, а не создаём запись задним числом.
                const openCountRow = await queryOne<{ count: number }>(
                  `SELECT count(*)::int AS count FROM employee_assignments
                   WHERE employee_id = $1 AND effective_to IS NULL`,
                  [u.id],
                );
                const openCount = openCountRow?.count ?? 0;

                let reopened = false;
                if (openCount === 0) {
                  const lastClosed = await queryOne<{ id: string; position_id: string | null; effective_to: string | null }>(
                    `SELECT id, position_id, effective_to FROM employee_assignments
                     WHERE employee_id = $1 AND org_department_id = $2 AND effective_to IS NOT NULL
                     ORDER BY effective_to DESC
                     LIMIT 1`,
                    [u.id, nextDeptId],
                  );
                  if (lastClosed) {
                    const nowIso = new Date().toISOString();
                    try {
                      await execute(
                        'UPDATE employee_assignments SET effective_to = NULL, updated_at = $1 WHERE id = $2',
                        [nowIso, lastClosed.id],
                      );
                      await execute(
                        `UPDATE employees SET org_department_id = $1, position_id = $2, updated_at = $3 WHERE id = $4`,
                        [nextDeptId, lastClosed.position_id || null, nowIso, u.id],
                      );
                      console.log('[syncEmployees] reopened orphaned assignment', {
                        employeeId: u.id, assignmentId: lastClosed.id, deptId: nextDeptId,
                        previousEffectiveTo: lastClosed.effective_to,
                      });
                      reopened = true;
                    } catch {
                      reopened = false;
                    }
                  }
                }

                if (!reopened) {
                  changeResult = await employeeChangesService.changeDepartment(u.id, nextDeptId, {
                    reason: 'Синхронизация Sigur',
                    lockDepartment: false,
                    skipIfScheduledToTarget: true,
                  });
                }
              }

              if (changeResult === 'skipped') {
                // Атомарный гард changeDepartment нашёл уже существующее назначение в целевой
                // отдел (перевод оформлен параллельно) → полный skip, как skip-local-dismissal:
                // без события увольнения, техдоступа и lifecycle-полей.
                console.log(`[syncEmployees] dept change skipped by atomic guard: ${u.name} (id=${u.id}) → ${nextDeptId}`);
                cleanUpdateFieldsForAction(u.fields, 'skip-local-dismissal', u.isDismissalDept, freshEmp?.employment_status ?? null);
                delete u.fields.position_id;
              } else {
                await upsertTechnicalDepartmentAccess(u.id, nextDeptId, freshDeptId || null, 'sigur_sync');
              }
            }
          }
          if (u.fields.position_id && prev && u.fields.position_id !== prev.position_id) {
            await employeeChangesService.changePosition(u.id, u.fields.position_id as string, {
              reason: 'Синхронизация Sigur',
            });
            delete u.fields.position_id;
          }
          // Остальные поля — прямой update
          const keys = Object.keys(u.fields);
          if (keys.length > 0) {
            try {
              const setParts: string[] = [];
              const params: unknown[] = [];
              for (const key of keys) {
                params.push(u.fields[key]);
                setParts.push(`${key} = $${params.length}`);
              }
              params.push(u.id);
              await execute(
                `UPDATE employees SET ${setParts.join(', ')} WHERE id = $${params.length}`,
                params,
              );
            } catch (err) {
              return { error: { message: err instanceof Error ? err.message : 'Unknown' } };
            }
          }
          employeeCache.invalidate(u.id);
          return { error: null };
        } catch (err) {
          return { error: { message: err instanceof Error ? err.message : 'Unknown' } };
        }
      })
    );
    for (let j = 0; j < results.length; j++) {
      if (!results[j].error) updated++;
      else errors.push(`update ${batch[j].name}: ${results[j].error!.message}`);
    }
  }

  send({ type: 'employees_progress', phase: 'saving', current: totalEmployees, total: totalEmployees, percent: 100 });

  const BATCH_SIZE = 100;
  const insertedAccessSeeds: Array<{ id: number; org_department_id: string }> = [];

  const INSERT_COLUMNS = [
    'full_name', 'last_name', 'first_name', 'middle_name', 'hire_date',
    'employment_status', 'is_archived', 'sigur_employee_id',
    'org_department_id', 'position_id', 'tab_number',
  ];

  const insertOneRow = async (row: Record<string, unknown>) => {
    const params: unknown[] = INSERT_COLUMNS.map(col => row[col] ?? null);
    const placeholders = INSERT_COLUMNS.map((_, idx) => `$${idx + 1}`).join(', ');
    return queryOne<{ id: number; org_department_id: string | null }>(
      `INSERT INTO employees (${INSERT_COLUMNS.join(', ')}) VALUES (${placeholders})
       RETURNING id, org_department_id`,
      params,
    );
  };

  for (let i = 0; i < inserts.length; i += BATCH_SIZE) {
    const batch = inserts.slice(i, i + BATCH_SIZE);
    // Пытаемся вставить пачкой одним запросом
    try {
      const allParams: unknown[] = [];
      const groups: string[] = [];
      for (const row of batch) {
        const group: string[] = [];
        for (const col of INSERT_COLUMNS) {
          allParams.push(row[col] ?? null);
          group.push(`$${allParams.length}`);
        }
        groups.push(`(${group.join(', ')})`);
      }
      const insertedRows = await query<{ id: number; org_department_id: string | null }>(
        `INSERT INTO employees (${INSERT_COLUMNS.join(', ')}) VALUES ${groups.join(', ')}
         RETURNING id, org_department_id`,
        allParams,
      );
      imported += batch.length;
      for (const row of insertedRows || []) {
        if (row.id && row.org_department_id) {
          insertedAccessSeeds.push({ id: row.id, org_department_id: row.org_department_id });
        }
      }
    } catch (insertError) {
      console.warn(`[syncEmployees] batch ${i / BATCH_SIZE + 1} failed: ${(insertError as Error).message}. Fallback to individual inserts.`);
      for (const row of batch) {
        try {
          const singleRow = await insertOneRow(row);
          imported++;
          if (singleRow?.id && singleRow.org_department_id) {
            insertedAccessSeeds.push({ id: singleRow.id, org_department_id: singleRow.org_department_id });
          }
        } catch (singleErr) {
          errors.push(`${(row as Record<string, unknown>).full_name}: ${(singleErr as Error).message}`);
        }
      }
    }
  }

  for (const seed of insertedAccessSeeds) {
    try {
      await upsertTechnicalDepartmentAccess(seed.id, seed.org_department_id, null, 'sigur_sync');
    } catch (accessError) {
      errors.push(`access insert ${seed.id}: ${(accessError as Error).message}`);
    }
  }

  // Авто-увольнение сотрудников, которых больше нет в SIGUR.
  // Защита от инцидентов: при подозрительно тонкой выгрузке Sigur и при попытке зафаерить
  // слишком многих за один проход — авто-fire отменяется целиком (см. инцидент 17.04.2026).
  const sigurIdSet = new Set<number>();
  for (const emp of sigurEmployees) {
    if (emp.id != null) sigurIdSet.add(emp.id);
  }

  const activeWithSigur = existingEmps.filter(e => e.employment_status === 'active').length;
  // Сотрудников с уже назначенным увольнением авто-fire не трогает: их применяет
  // dismissal-scheduler своей датой (в т.ч. просроченные после простоя сервера).
  // Иначе увольнение «на сегодня до 23:00 МСК» или на будущую дату применялось бы раньше срока.
  const skippedAutoFireWithDismissal = existingEmps.filter(
    e => e.employment_status === 'active' && !sigurIdSet.has(e.sigur_employee_id) && e.dismissal_date != null,
  ).length;
  const toAutoFire = existingEmps.filter(
    e => e.employment_status === 'active'
      && !sigurIdSet.has(e.sigur_employee_id)
      && e.dismissal_date == null,
  );
  if (skippedAutoFireWithDismissal > 0) {
    console.log(`[syncEmployees] auto-fire skip (dismissal scheduled): ${skippedAutoFireWithDismissal}`);
  }

  const safety = evaluateAutoFireSafety(activeWithSigur, sigurEmployees.length, toAutoFire.length, {
    absoluteLimit: Number(process.env.SIGUR_AUTOFIRE_MAX) || undefined,
  });

  let autoFired = 0;
  // МСК-дата: UTC-срезка в окне 00:00–03:00 МСК давала вчерашнее число.
  const today = syncTodayIso;
  const autoFiredIds: number[] = [];

  if (safety.shouldSkip) {
    console.error(`[syncEmployees] ${safety.reason}`);
    errors.push(safety.reason!);
  } else {
    const autoFireExclDate = formatDateShift(today, 1);
    // Архивный отдел резолвим ОДИН раз до цикла: создание отдела не должно
    // происходить внутри транзакции сотрудника.
    let autoFireArchiveDeptId: string | null = archiveLocalDeptId;
    if (toAutoFire.length > 0 && !autoFireArchiveDeptId) {
      try {
        autoFireArchiveDeptId = (await ensureLocalArchiveDepartment(null, { connection })).id;
      } catch (archiveErr) {
        errors.push(`auto-fire archive resolve: ${(archiveErr as Error).message}`);
      }
    }

    for (const emp of toAutoFire) {
      try {
        // Всё состояние увольнения — в одной транзакции: при ошибке любого шага
        // сотрудник не остаётся fired без истории и без переноса в архив.
        const applied = await withTransaction(async (client) => {
          const fired = await client.query<{ id: number }>(
            `UPDATE employees
                SET employment_status = 'fired',
                    dismissal_date = $1,
                    excluded_from_timesheet = true,
                    excluded_from_timesheet_date = $2,
                    updated_at = $3
              WHERE id = $4
                AND employment_status = 'active'
                AND dismissal_date IS NULL
                AND dismissal_apply_started_at IS NULL
              RETURNING id`,
            [today, autoFireExclDate, new Date().toISOString(), emp.id],
          );
          if (fired.rowCount === 0) return false;

          // Фиксируем реальный отдел (до архивации) в событии увольнения — для связности истории.
          if (emp.org_department_id && emp.org_department_id !== autoFireArchiveDeptId) {
            await client.query(
              `INSERT INTO employee_dismissal_events
                 (employee_id, dismissal_date, scheduled, from_department_id, created_by)
               VALUES ($1, $2, false, $3, NULL)`,
              [emp.id, today, emp.org_department_id],
            );
          }

          if (autoFireArchiveDeptId) {
            await client.query(
              `UPDATE employee_assignments
                  SET effective_to = $1
                WHERE employee_id = $2 AND effective_to IS NULL`,
              [today, emp.id],
            );
            await client.query(
              `UPDATE employees
                  SET org_department_id = $1, department_locked = false, updated_at = $2
                WHERE id = $3`,
              [autoFireArchiveDeptId, new Date().toISOString(), emp.id],
            );
          }

          await client.query(
            `UPDATE employee_department_access
                SET is_active = false, updated_at = $1
              WHERE employee_id = $2 AND is_active = true`,
            [new Date().toISOString(), emp.id],
          );

          return true;
        });

        if (applied) {
          autoFired++;
          autoFiredIds.push(emp.id);
          employeeCache.invalidate(emp.id);
        } else {
          console.log(`[syncEmployees] auto-fire skip (state changed): id=${emp.id}`);
        }
      } catch (fireErr) {
        errors.push(`auto-fire ${emp.id}: ${(fireErr as Error).message}`);
      }
    }

    if (autoFiredIds.length > 0) {
      invalidateTimekeeperScopeCache();
    }

    if (autoFired > 0) {
      console.log(`[syncEmployees] auto-fired ${autoFired} employees not found in Sigur`);
    }
  }

  // Перенос всех fired сотрудников в архивную папку Sigur (идемпотентно).
  // Сотрудников без sigur_employee_id пропускаем — их нет в Sigur, переносить некуда.
  // Это же штатно устраняет расхождения firedMismatch (fired в ФОТ / рабочий отдел в Sigur).
  const firedMismatchSigurIds = new Set(firedMismatch.map(m => m.sigurId));
  let firedMismatchResolved = 0;
  try {
    const sigurSettings = await settingsService.getSigurConnectionSettings();
    if (!sigurSettings.archiveDepartmentId) {
      console.warn('[syncEmployees] archive department not configured — skip fired->archive sync');
    } else {
      const archiveDepartmentId = sigurSettings.archiveDepartmentId;

      const sigurDeptById = new Map<number, number | null>();
      for (const emp of sigurEmployees) {
        if (emp.id != null) sigurDeptById.set(emp.id, emp.departmentId ?? null);
      }

      let firedRows: { id: number; sigur_employee_id: number | null }[];
      try {
        firedRows = await query<{ id: number; sigur_employee_id: number | null }>(
          `SELECT id, sigur_employee_id FROM employees
           WHERE employment_status = 'fired' AND sigur_employee_id IS NOT NULL`,
        );
      } catch (firedErr) {
        errors.push(`fired->archive select: ${(firedErr as Error).message}`);
        firedRows = [];
      }

      {
        const toMove: number[] = [];
        let skippedNotInSigur = 0;
        let skippedAlreadyArchived = 0;

        for (const row of firedRows ?? []) {
          const sid = row.sigur_employee_id as number | null;
          if (sid == null) continue;
          if (!sigurDeptById.has(sid)) { skippedNotInSigur++; continue; }
          if (sigurDeptById.get(sid) === archiveDepartmentId) { skippedAlreadyArchived++; continue; }
          toMove.push(sid);
        }

        if (toMove.length > 0) {
          const moveResult = await batchMoveSigurEmployees(toMove, archiveDepartmentId, connection);
          const failedSet = new Set(moveResult.failedIds);
          firedMismatchResolved = toMove.filter(
            sid => firedMismatchSigurIds.has(sid) && !failedSet.has(sid),
          ).length;
          console.log(
            `[syncEmployees] fired->archive moved=${moveResult.moved}/${moveResult.requested} ` +
            `failed=${moveResult.failedIds.length} skipped_not_in_sigur=${skippedNotInSigur} ` +
            `skipped_already_archived=${skippedAlreadyArchived}`,
          );
          if (moveResult.failedIds.length > 0) {
            errors.push(`fired->archive failed ids: ${moveResult.failedIds.join(',')}`);
          }
        } else if (skippedNotInSigur > 0 || skippedAlreadyArchived > 0) {
          console.log(
            `[syncEmployees] fired->archive moved=0 ` +
            `skipped_not_in_sigur=${skippedNotInSigur} skipped_already_archived=${skippedAlreadyArchived}`,
          );
        }
      }
    }
  } catch (archiveSyncErr) {
    errors.push(`fired->archive sync: ${(archiveSyncErr as Error).message}`);
  }

  const firedMismatchUnresolved = Math.max(0, firedMismatch.length - firedMismatchResolved);

  if (firedMismatch.length > 0) {
    console.warn(
      `[syncEmployees] fired mismatch detected=${firedMismatch.length} unresolved=${firedMismatchUnresolved}`,
    );
    try {
      await auditService.log({
        user_id: null,
        action: 'SIGUR_SYNC_FIRED_MISMATCH',
        entity_type: 'employee',
        details: {
          detected: firedMismatch.length,
          unresolved: firedMismatchUnresolved,
          employees: firedMismatch.slice(0, 50),
        },
      });
    } catch (auditErr) {
      console.error('[syncEmployees] fired mismatch audit failed:', auditErr);
    }
  }

  console.log(`[syncEmployees] done: ${imported} imported, ${updated} updated, ${skipped} skipped, ${unmatchedList.length} unmatched, ${autoFired} auto-fired`);

  // Сбрасываем локальный кэш presence-polling, чтобы первые события нового/изменённого
  // сотрудника сразу привязывались к employee_id без ожидания TTL кэша (10 мин).
  if (imported > 0 || updated > 0 || autoFired > 0) {
    invalidatePresencePollingEmployeeCache();
  }

  return {
    imported,
    updated,
    skipped,
    total: sigurEmployeesRaw.length,
    errors,
    unmatched: unmatchedList,
    auto_fired: autoFired,
    fired_mismatch_detected: firedMismatch.length,
    fired_mismatch_unresolved: firedMismatchUnresolved,
  };
}
