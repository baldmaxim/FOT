/**
 * Сбор живого состояния Sigur + ФОТ для гашения пропусков старого образца.
 *
 * Один источник истины для обоих скриптов: инвентаризация и боевой preflight обязаны
 * классифицировать карты ОДИНАКОВО — иначе denylist при apply разойдётся с тем, что
 * человек видел в Excel, и новая красная карта может проскочить в гашение.
 *
 * Только чтение: ни одного write-вызова в Sigur, БД используется через SELECT.
 */
import fs from 'fs';
import path from 'path';
import type { ConnectionType } from './sigur-base.service.js';
import { sigurService } from './sigur.service.js';
import { query } from '../config/postgres.js';
import { getContractorRootId } from '../config/contractor.js';
import { deriveCardW26, deriveSigurCardIdentity } from './sigur-card-w26.util.js';
import { resolveField, normalizeDepartmentLookupName } from './sigur-sync-shared.js';
import {
  collectSigurDepartmentDescendantIds,
  formatW26,
  getNormalizedDepartments,
  normalizeInt,
  toCardSummary,
} from './sigur-live-admin.service.js';
import {
  classifyCardGeneration,
  hasFotPoolNote,
  hashDescendantSet,
  normalizeDepartmentId,
  resolveScopeBucket,
  type ICardFacts,
  type IControlNodeSnapshot,
  type IInventoryCard,
  type ILiveBinding,
  type ScopeBucket,
} from './old-card-block.util.js';

/** Ветки верхнего уровня, которые не блокируются ни при каких условиях. */
export const EXCLUDED_BRANCH_NAMES = [
  '(СУ-10) ООО СУ-10',
  '(СМ) Служба Механизации',
  'Уволенные',
  'test',
] as const;

/** Плейсхолдер пула в Sigur — та же маска, что в contractor-pool.service.ts:414. */
export const POOL_PLACEHOLDER_RE = /^\s*Пропуск\s/i;

/** Файл, который производит scripts/diagnose-deleted-passes.ts. */
export const DELETED_BLACKLIST_FILE = 'deleted-passes-blacklist.json';

export interface INormalizedDept { id: number; parentId: number | null; name: string }

export interface IEmployeeInfo {
  id: number;
  name: string | null;
  note: string | null;
  departmentId: number | null;
  departmentName: string | null;
  isKnownDepartment: boolean;
  scopeBucket: ScopeBucket;
  topLevel: string;
}

export interface IPassRow {
  pass_number: string;
  holder_name: string | null;
  sigur_employee_id: string | null;
  card_uid: string | null;
  card_hex_uid: string | null;
  status: string;
  org_name: string | null;
}

/** Строка «сотрудник → карта» с классификацией и контекстом для отчёта. */
export interface ICardRow extends IInventoryCard {
  topLevel: string;
  note: string | null;
  departmentName: string | null;
  passNumber: string | null;
  passStatus: string | null;
  passHexUid: string | null;
  reason: string;
  cardsPerEmployee: number;
}

export interface ILiveState {
  connection: ConnectionType;
  departments: INormalizedDept[];
  contractorSigurId: number;
  contractorDescendants: Set<number>;
  excludedDescendants: Set<number>;
  controlNodes: Record<string, IControlNodeSnapshot>;
  employees: Map<number, IEmployeeInfo>;
  rows: ICardRow[];
  /** Сотрудники с доказанно новым пропуском: карта generation='new' либо FOT-POOL в примечании. */
  employeesWithNewCard: Set<number>;
  /** cardId карт, связанных с модулем выдачи — побеждает allowlist всегда. */
  denylist: Set<number>;
  /** cardId всех сотрудников СУ-10 / Службы механизации — независимый жёсткий запрет. */
  excludedBranchCardIds: Set<number>;
  /** facility партий, засветившихся в модуле выдачи — вся партия под запретом. */
  moduleFacilities: Set<number>;
  /** Факты по каждой карте каталога — для повторной классификации при per-record гардах. */
  cardFactsById: Map<number, ICardFacts>;
  /** cardId, встретившиеся более чем в одной привязке (неоднозначность). */
  duplicateCardIds: Set<number>;
  rootlessComplete: boolean;
  failedDepartmentIds: number[];
}

export interface ICollectOptions {
  /** Нужны ли сотрудники вне папок: при true неполная выгрузка — фатальна. */
  requireRootless: boolean;
  /** cardId из внешнего confirmation-файла — единственный источник статуса confirmed_white. */
  confirmedWhiteCardIds?: ReadonlySet<number>;
  /**
   * Путь к результату diagnose-deleted-passes.ts. Обязателен: строки contractor_passes
   * удаляются физически, и без разбора этой истории отсутствие строки ничего не доказывает.
   */
  deletedBlacklistPath?: string;
  log?: (message: string) => void;
}

interface IDeletedTrace { cardIds: Set<number>; employeeIds: Set<number> }

/** Чтение чёрного списка удалённых пропусков. Нет файла или он битый — сбор падает. */
function loadDeletedBlacklist(filePath: string): IDeletedTrace {
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Не найден ${filePath}. Сначала выполните: npx tsx scripts/diagnose-deleted-passes.ts — `
      + 'без разбора удалённых строк критерий «вне модуля ⇒ не красная» недоказуем',
    );
  }
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
    kind?: string;
    blockedCardIds?: number[];
    blockedEmployeeIds?: number[];
  };
  if (parsed.kind !== 'deleted-passes-blacklist') throw new Error(`${filePath}: это не файл чёрного списка`);
  if (!Array.isArray(parsed.blockedCardIds) || !Array.isArray(parsed.blockedEmployeeIds)) {
    throw new Error(`${filePath}: отсутствуют blockedCardIds / blockedEmployeeIds`);
  }
  return {
    cardIds: new Set(parsed.blockedCardIds),
    employeeIds: new Set(parsed.blockedEmployeeIds),
  };
}

/**
 * READ-ONLY чтение всех привязок карты — источник истины для аудита гашения.
 *
 * Фильтр только по cardId, без employeeId: запрос по старому владельцу при перепривязке
 * вернёт пусто и смена держателя замаскируется под «привязки нет». Контур передаётся явно,
 * чтобы GET гарантированно ушёл туда же, где собирался план прогона.
 */
export async function readLiveBindingsByCard(
  cardId: number,
  connection: ConnectionType,
): Promise<ILiveBinding[]> {
  const raw = await sigurService.getCardBindings({ cardId }, connection) as Record<string, unknown>[];
  const out: ILiveBinding[] = [];
  for (const item of raw) {
    const holder = item.holder && typeof item.holder === 'object' ? item.holder as Record<string, unknown> : null;
    const owner = normalizeInt(
      resolveField(item, 'employeeId', 'employee_id')
      ?? (holder ? resolveField(holder, 'holderId', 'holder_id', 'id') : null),
    );
    const id = normalizeInt(resolveField(item, 'cardId', 'card_id', 'id'));
    if (id !== cardId) continue;
    out.push({
      employeeId: owner,
      cardId: id,
      startDate: String(resolveField<string>(item, 'startDate', 'start_date', 'validFrom') ?? '').trim() || null,
      expirationDate: String(
        resolveField<string>(item, 'expirationDate', 'expiration_date', 'expiresAt', 'validTo') ?? '',
      ).trim() || null,
    });
  }
  return out;
}

const normValue = (value: string): string => value.toUpperCase().replace(/^0+/, '');
const normW26Key = (value: string): string => {
  const match = value.replace(/\s/g, '').match(/^(\d+),(\d+)$/);
  return match ? `${Number(match[1])},${Number(match[2])}` : '';
};

export async function collectLiveState(options: ICollectOptions): Promise<ILiveState> {
  const log = options.log ?? ((message: string) => console.log(message));
  const confirmedWhiteCardIds = options.confirmedWhiteCardIds ?? new Set<number>();
  const deletedTrace = loadDeletedBlacklist(
    options.deletedBlacklistPath
    ?? path.resolve(process.cwd(), 'temp', DELETED_BLACKLIST_FILE),
  );
  log(`[удалённые] в чёрном списке: карт ${deletedTrace.cardIds.size}, сотрудников ${deletedTrace.employeeIds.size}`);
  const connection = await sigurService.getBackgroundConnectionType();
  log(`[sigur] контур: ${connection}`);
  log(`[подтверждения] карт с внешним подтверждением: ${confirmedWhiteCardIds.size}`);

  // ── Дерево отделов и контрольные узлы ────────────────────────────────────────────
  const departments: INormalizedDept[] = await getNormalizedDepartments(connection);
  if (departments.length === 0) throw new Error('Sigur вернул пустое дерево отделов — продолжать нельзя');
  log(`[sigur] отделов в дереве: ${departments.length}`);

  const deptById = new Map<number, INormalizedDept>(departments.map(dept => [dept.id, dept]));

  const resolveBranch = (name: string): INormalizedDept => {
    const target = normalizeDepartmentLookupName(name);
    const matches = departments.filter(dept => normalizeDepartmentLookupName(dept.name) === target);
    const topLevel = matches.filter(dept => dept.parentId === null);
    const chosen = topLevel.length > 0 ? topLevel : matches;
    if (chosen.length === 0) throw new Error(`Ветка "${name}" не найдена в дереве Sigur — стоп`);
    if (chosen.length > 1) {
      throw new Error(`Ветка "${name}" найдена ${chosen.length} раз (id: ${chosen.map(d => d.id).join(', ')}) — стоп`);
    }
    return chosen[0];
  };

  // getContractorRootId возвращает UUID строки org_departments, а не Sigur ID.
  const contractorRootUuid = await getContractorRootId();
  if (!contractorRootUuid) throw new Error('Корень «Подрядные организации» не найден в org_departments — стоп');
  const rootRow = await query<{ sigur_department_id: number | null }>(
    'SELECT sigur_department_id FROM org_departments WHERE id = $1',
    [contractorRootUuid],
  );
  const contractorSigurId = rootRow[0]?.sigur_department_id ?? null;
  if (!contractorSigurId) throw new Error('У корня «Подрядные организации» пуст sigur_department_id — стоп');
  if (!deptById.has(contractorSigurId)) {
    throw new Error(`Узел ${contractorSigurId} («Подрядные организации») отсутствует в живом дереве Sigur — стоп`);
  }

  const contractorDescendants = collectSigurDepartmentDescendantIds(contractorSigurId, departments);
  log(`[scope] «Подрядные организации» = ${contractorSigurId}, узлов в поддереве: ${contractorDescendants.size}`);

  const snapshotOf = (dept: INormalizedDept): IControlNodeSnapshot => ({
    id: dept.id,
    parentId: dept.parentId,
    descendantsHash: hashDescendantSet(collectSigurDepartmentDescendantIds(dept.id, departments)),
  });

  const controlNodes: Record<string, IControlNodeSnapshot> = {
    contractors: snapshotOf(deptById.get(contractorSigurId)!),
  };
  const excludedDescendants = new Set<number>();
  for (const name of EXCLUDED_BRANCH_NAMES) {
    const branch = resolveBranch(name);
    controlNodes[name] = snapshotOf(branch);
    for (const id of collectSigurDepartmentDescendantIds(branch.id, departments)) excludedDescendants.add(id);
    log(`[scope] исключено: "${name}" = ${branch.id}`);
  }

  const topLevelNameByDept = new Map<number, string>();
  const resolveTopLevel = (deptId: number): string => {
    const cached = topLevelNameByDept.get(deptId);
    if (cached) return cached;
    const chain: number[] = [];
    let current: INormalizedDept | undefined = deptById.get(deptId);
    const guard = new Set<number>();
    while (current && current.parentId !== null && !guard.has(current.id)) {
      guard.add(current.id);
      chain.push(current.id);
      current = deptById.get(current.parentId);
    }
    const name = current?.name ?? '(неизвестно)';
    for (const id of chain) topLevelNameByDept.set(id, name);
    if (current) topLevelNameByDept.set(current.id, name);
    return name;
  };

  // ── Сотрудники: полнота обязательна ──────────────────────────────────────────────
  const { employeesRaw, rootlessComplete, failedDepartmentIds } = await fetchEmployeesStrict(
    connection,
    departments,
    contractorDescendants,
    log,
  );
  if (options.requireRootless && !rootlessComplete) {
    throw new Error('Полная выгрузка сотрудников недоступна — корневых сотрудников подтвердить нельзя, стоп');
  }

  const employees = new Map<number, IEmployeeInfo>();
  for (const raw of employeesRaw) {
    const id = normalizeInt(resolveField(raw, 'id', 'ID', 'Id'));
    if (!id) continue;
    const departmentId = normalizeDepartmentId(
      resolveField(raw, 'departmentId', 'department_id', 'departmentID', 'department'),
    );
    // 'invalid' — значение есть, но числом не является: корнем такое считать нельзя.
    const numericDepartmentId = typeof departmentId === 'number' ? departmentId : null;
    const isKnownDepartment = numericDepartmentId !== null && deptById.has(numericDepartmentId);
    employees.set(id, {
      id,
      name: String(resolveField<string>(raw, 'name', 'fullName', 'full_name') ?? '').trim() || null,
      note: String(resolveField<string>(raw, 'description', 'note', 'comment', 'Description') ?? '').trim() || null,
      departmentId: numericDepartmentId,
      departmentName: numericDepartmentId !== null ? deptById.get(numericDepartmentId)?.name ?? null : null,
      isKnownDepartment,
      scopeBucket: resolveScopeBucket({ departmentId, isKnownDepartment, contractorDescendants, excludedDescendants }),
      topLevel: isKnownDepartment ? resolveTopLevel(numericDepartmentId!) : '(вне папок)',
    });
  }
  log(`[sigur] сотрудников разобрано: ${employees.size}`);

  // ── Каталог карт ─────────────────────────────────────────────────────────────────
  const cardsRaw = await sigurService.getCardsCached(connection);
  log(`[sigur] карт в каталоге: ${cardsRaw.length}`);

  interface ICardInfo { cardId: number; value: string | null; w26: string | null; facility: number | null }
  const cardById = new Map<number, ICardInfo>();
  const cardIdByKey = new Map<string, number[]>();
  const addKey = (key: string, cardId: number): void => {
    if (!key) return;
    const list = cardIdByKey.get(key) ?? [];
    list.push(cardId);
    cardIdByKey.set(key, list);
  };

  for (const raw of cardsRaw) {
    const cardId = normalizeInt(resolveField(raw, 'id', 'ID', 'cardId', 'card_id'));
    if (!cardId) continue;
    const rawValue = String(resolveField<string>(raw, 'value', 'cardValue', 'card_value') ?? '').trim();
    const rawFormatted = String(resolveField<string>(raw, 'formattedValue', 'formatted_value') ?? '').trim();
    // Тот же helper, что и в боевой сверке перед записью: иначе confirmation и apply
    // выведут идентичность по-разному и гашение упрётся в ложные пропуски.
    const identity = deriveSigurCardIdentity(rawValue, rawFormatted);
    const info: ICardInfo = { cardId, ...identity };
    cardById.set(cardId, info);
    if (info.value) addKey(`v:${normValue(info.value)}`, cardId);
    if (info.w26) addKey(`w:${normW26Key(info.w26)}`, cardId);
    if (rawFormatted) addKey(`w:${normW26Key(rawFormatted)}`, cardId);
  }

  // ── Привязки ─────────────────────────────────────────────────────────────────────
  const bindingsRaw = await sigurService.getCardBindings(undefined, connection) as Record<string, unknown>[];
  log(`[sigur] привязок карт: ${bindingsRaw.length}`);

  const bindingsByEmployee = new Map<number, Array<{
    cardId: number; startDate: string | null; expirationDate: string | null; format: string | null;
  }>>();
  const cardIdSeen = new Map<number, number>();
  for (const raw of bindingsRaw) {
    const holder = raw.holder && typeof raw.holder === 'object' ? raw.holder as Record<string, unknown> : null;
    const employeeId = normalizeInt(
      resolveField(raw, 'employeeId', 'employee_id')
      ?? (holder ? resolveField(holder, 'holderId', 'holder_id', 'id') : null),
    );
    const summary = toCardSummary(raw);
    if (!employeeId || !summary) continue;
    const list = bindingsByEmployee.get(employeeId) ?? [];
    list.push({
      cardId: summary.cardId,
      startDate: summary.startDate,
      expirationDate: summary.expirationDate,
      format: summary.format,
    });
    bindingsByEmployee.set(employeeId, list);
    cardIdSeen.set(summary.cardId, (cardIdSeen.get(summary.cardId) ?? 0) + 1);
  }
  const duplicateCardIds = new Set(
    [...cardIdSeen.entries()].filter(([, count]) => count > 1).map(([cardId]) => cardId),
  );

  // ── Пропуска ФОТ ─────────────────────────────────────────────────────────────────
  // ВСЕ статусы, включая revoked: отозванный пропуск тоже доказывает, что карта
  // проходила через модуль, а значит могла быть красной.
  const passes = await query<IPassRow>(
    `SELECT p.pass_number, p.holder_name, p.sigur_employee_id::text AS sigur_employee_id,
            p.card_uid, p.card_hex_uid, p.status, od.name AS org_name
       FROM contractor_passes p
       LEFT JOIN org_departments od ON od.id = p.org_department_id`,
  );
  log(`[фот] пропусков (все статусы, включая revoked): ${passes.length}`);

  // Employee-level запрет: сотрудник с любой строкой модуля защищает все свои карты.
  const employeesWithPassRow = new Set<number>();
  for (const pass of passes) {
    if (pass.sigur_employee_id) employeesWithPassRow.add(Number(pass.sigur_employee_id));
  }
  log(`[фот] сотрудников со строкой модуля: ${employeesWithPassRow.size}`);

  // Сопоставление ТОЛЬКО точным W26: матчер Sigur ?value= префиксный и даёт чужие карты.
  const passesByCardId = new Map<number, IPassRow[]>();
  const orgNameByEmployee = new Map<number, string>();
  for (const pass of passes) {
    const employeeId = pass.sigur_employee_id ? Number(pass.sigur_employee_id) : null;
    if (employeeId && pass.org_name) orgNameByEmployee.set(employeeId, pass.org_name);
    if (!pass.card_uid) continue;
    let candidates: number[] = [];
    try {
      const decoded = deriveCardW26(pass.card_uid);
      candidates = [
        ...(cardIdByKey.get(`v:${normValue(decoded.value)}`) ?? []),
        ...(cardIdByKey.get(`w:${normW26Key(formatW26(decoded))}`) ?? []),
      ];
    } catch {
      candidates = cardIdByKey.get(`w:${normW26Key(pass.card_uid)}`) ?? [];
    }
    for (const cardId of new Set(candidates)) {
      const list = passesByCardId.get(cardId) ?? [];
      list.push(pass);
      passesByCardId.set(cardId, list);
    }
  }

  // Владельцы карт — нужны, чтобы понять, лежит ли карта на профиле пула.
  const employeeIdByCardId = new Map<number, number>();
  for (const [employeeId, bindings] of bindingsByEmployee) {
    for (const binding of bindings) employeeIdByCardId.set(binding.cardId, employeeId);
  }

  // Факты по каждой карте каталога — общий источник для отчёта и для per-record гардов.
  // Строятся в два прохода: сначала прямые признаки связи с модулем, затем — признак
  // партии, который вычислим только после того, как известны все модульные карты.
  const cardFactsById = new Map<number, ICardFacts>();
  for (const [cardId, info] of cardById) {
    const matched = passesByCardId.get(cardId) ?? [];
    const ownerId = employeeIdByCardId.get(cardId) ?? null;
    const owner = ownerId !== null ? employees.get(ownerId) : undefined;
    cardFactsById.set(cardId, {
      cardId,
      value: info.value,
      w26: info.w26,
      facility: info.facility,
      moduleLink: {
        poolProfile: hasFotPoolNote(owner?.note),
        poolPlaceholderName: !!owner?.name && POOL_PLACEHOLDER_RE.test(owner.name),
        inPassModule: matched.length > 0,
        employeeHasPassRow: ownerId !== null && employeesWithPassRow.has(ownerId),
        readerIssued: matched.some(pass => !!pass.card_hex_uid),
        deletedPassTrace: deletedTrace.cardIds.has(cardId)
          || (ownerId !== null && deletedTrace.employeeIds.has(ownerId)),
        moduleFacilityBatch: false, // второй проход ниже
      },
    });
  }

  // Второй проход: партии, засветившиеся в модуле. Физическая партия однородна —
  // если хоть одна карта facility выдана через модуль, вся партия потенциально красная.
  // Это ловит удалённые пуловые пропуска, чьи профили переименованы в ФИО.
  const moduleFacilities = new Set<number>();
  for (const facts of cardFactsById.values()) {
    const link = facts.moduleLink;
    const linkedDirectly = link.poolProfile || link.poolPlaceholderName || link.inPassModule
      || link.employeeHasPassRow || link.readerIssued || link.deletedPassTrace;
    if (linkedDirectly && facts.facility !== null) moduleFacilities.add(facts.facility);
  }
  for (const facts of cardFactsById.values()) {
    if (facts.facility !== null && moduleFacilities.has(facts.facility)) {
      facts.moduleLink.moduleFacilityBatch = true;
    }
  }
  log(`[партии] facility, засветившихся в модуле: ${moduleFacilities.size}`);

  // ── Классификация ────────────────────────────────────────────────────────────────
  const rows: ICardRow[] = [];
  const employeesWithNewCard = new Set<number>();
  const denylist = new Set<number>();
  const excludedBranchCardIds = new Set<number>();

  for (const [employeeId, bindings] of bindingsByEmployee) {
    const employee = employees.get(employeeId);
    // Карты сотрудников СУ-10 / Службы механизации — в жёсткий запрет независимо от всего
    // остального. Сюда же попадают карты людей с битым departmentId (bucket 'anomaly').
    if (employee?.scopeBucket === 'excluded' || employee?.scopeBucket === 'anomaly') {
      for (const binding of bindings) excludedBranchCardIds.add(binding.cardId);
    }
    for (const binding of bindings) {
      const facts = cardFactsById.get(binding.cardId) ?? {
        cardId: binding.cardId,
        value: null,
        w26: null,
        facility: null,
        moduleLink: {
          poolProfile: false,
          poolPlaceholderName: false,
          inPassModule: false,
          // Карты нет в каталоге — доказать отсутствие связи с модулем нельзя,
          // поэтому employee-level признак считаем взведённым (fail-closed).
          employeeHasPassRow: employeesWithPassRow.has(employeeId),
          readerIssued: false,
          deletedPassTrace: deletedTrace.employeeIds.has(employeeId),
          moduleFacilityBatch: false,
        },
      };
      const matched = passesByCardId.get(binding.cardId) ?? [];
      const pass = matched.length === 1 ? matched[0] : null;
      const classification = classifyCardGeneration(facts, confirmedWhiteCardIds);

      if (classification.generation === 'module_linked') {
        employeesWithNewCard.add(employeeId);
        denylist.add(binding.cardId);
      }
      const info = { value: facts.value, w26: facts.w26, facility: facts.facility };

      rows.push({
        cardId: binding.cardId,
        sigurEmployeeId: employeeId,
        employeeName: employee?.name ?? pass?.holder_name ?? null,
        orgName: employee?.departmentName ?? orgNameByEmployee.get(employeeId) ?? null,
        departmentId: employee?.departmentId ?? null,
        scopeBucket: employee?.scopeBucket ?? 'anomaly',
        generation: classification.generation,
        value: info.value,
        w26: info.w26,
        facility: info.facility,
        format: binding.format,
        startDate: binding.startDate,
        expirationDate: binding.expirationDate,
        topLevel: employee?.topLevel ?? '(сотрудник не найден)',
        note: employee?.note ?? null,
        departmentName: employee?.departmentName ?? null,
        passNumber: pass?.pass_number ?? (matched.length > 1 ? `${matched.length} совпадений` : null),
        passStatus: pass?.status ?? null,
        passHexUid: pass?.card_hex_uid ?? null,
        reason: classification.reason,
        cardsPerEmployee: bindings.length,
      });
    }
  }

  // FOT-POOL — признак сотрудника: у него новый пропуск, его карты не трогаем вовсе.
  for (const employee of employees.values()) {
    if (hasFotPoolNote(employee.note)) employeesWithNewCard.add(employee.id);
  }

  log(`[итог] строк «сотрудник → карта»: ${rows.length}; сотрудников с модульным пропуском: ${employeesWithNewCard.size}`);
  log(`[защита] карт в исключённых ветках (СУ-10 / СМ / аномалии): ${excludedBranchCardIds.size}`);

  return {
    connection,
    departments,
    contractorSigurId,
    contractorDescendants,
    excludedDescendants,
    controlNodes,
    employees,
    rows,
    employeesWithNewCard,
    denylist,
    excludedBranchCardIds,
    moduleFacilities,
    cardFactsById,
    duplicateCardIds,
    rootlessComplete,
    failedDepartmentIds,
  };
}

/**
 * Выгрузка сотрудников с гарантией полноты.
 *
 * getEmployeesCached при таймауте падает в per-department скан (людей без отдела он не
 * увидит) и помечает кэш полным, а getEmployeesByDepartments глотает ошибку отдельного
 * отдела и молча отдаёт частичный список. Оба варианта здесь недопустимы.
 */
async function fetchEmployeesStrict(
  connection: ConnectionType,
  departments: INormalizedDept[],
  contractorDescendants: ReadonlySet<number>,
  log: (message: string) => void,
): Promise<{ employeesRaw: Record<string, unknown>[]; rootlessComplete: boolean; failedDepartmentIds: number[] }> {
  try {
    const full = await sigurService.getEmployees(undefined, connection) as Record<string, unknown>[];
    if (!Array.isArray(full) || full.length === 0) throw new Error('полная выгрузка вернула 0 сотрудников');
    log(`[sigur] сотрудников (полная выгрузка): ${full.length}`);
    return { employeesRaw: full, rootlessComplete: true, failedDepartmentIds: [] };
  } catch (error) {
    log(`[sigur] полная выгрузка не удалась (${(error as Error).message}); строгий обход по отделам`);
  }

  const ids = departments.map(dept => dept.id);
  const collected = new Map<number, Record<string, unknown>>();
  const failedDepartmentIds: number[] = [];
  let cursor = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (cursor < ids.length) {
      const deptId = ids[cursor++];
      try {
        const page = await sigurService.getEmployees({ departmentId: deptId }, connection) as Record<string, unknown>[];
        for (const employee of page) {
          const id = normalizeInt(resolveField(employee, 'id', 'ID', 'Id'));
          if (id) collected.set(id, employee);
        }
      } catch {
        failedDepartmentIds.push(deptId);
      }
    }
  }));

  const failedInContractors = failedDepartmentIds.filter(id => contractorDescendants.has(id));
  if (failedInContractors.length > 0) {
    throw new Error(
      `Не загружены отделы подрядного поддерева (${failedInContractors.join(', ')}) — данные неполны, стоп`,
    );
  }
  log(`[sigur] строгий обход: ${collected.size} сотрудников, провалов вне подрядчиков: ${failedDepartmentIds.length}`);
  return { employeesRaw: [...collected.values()], rootlessComplete: false, failedDepartmentIds };
}
