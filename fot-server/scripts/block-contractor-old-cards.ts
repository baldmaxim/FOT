/**
 * Гашение пропусков старого образца (белый пластик) у подрядчиков и корневых сотрудников Sigur.
 *
 * «Заблокировать» = просрочить привязку карты (expirationDate → вчера 23:59 МСК). Карта
 * остаётся в Sigur, привязка к человеку цела, история проходов цела. Профиль сотрудника
 * не трогается вообще: ни block, ни updateEmployee.
 *
 * Fail-closed: гасятся ТОЛЬКО карты из внешнего confirmation-файла, прошедшие все живые
 * гарды. Любая неполнота данных даёт пропуск, а не запись. Право гасить не выдаёт ни одна
 * эвристика — ни facility, ни даты, ни card_hex_uid.
 *
 * Режимы:
 *   dry-run (по умолчанию) — ничего не пишет, порождает block-plan-<ts>.json + planHash
 *     npx tsx scripts/block-contractor-old-cards.ts --input=temp/inventory-<ts>.json  *       --confirmations=temp/white-confirmation-<ts>.tsv
 *   apply — боевой, требует план, его хеш и тот же confirmation-файл
 *     npx tsx scripts/block-contractor-old-cards.ts --plan=temp/block-plan-<ts>.json  *       --confirmations=<тот же файл> --confirm-plan=<hash> --apply --expect=<N>
 *   rollback — возврат прежних дат по журналу
 *     npx tsx scripts/block-contractor-old-cards.ts --rollback=temp/block-old-cards-<ts>.jsonl --apply
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { ILiveState } from '../src/services/old-card-block.collect.js';
import type {
  ILiveBinding,
  IInventoryCard,
  SkipReason,
  WriteOutcome,
} from '../src/services/old-card-block.util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const parseEnvLastWins = (text: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
};

const LOCAL_CA = path.resolve(__dirname, '../../.migration/yandex-ca.pem');
if (fs.existsSync(LOCAL_CA)) {
  process.env.NODE_ENV = 'test';
  const envFile = parseEnvLastWins(fs.readFileSync(path.resolve(__dirname, '../.env'), 'utf8'));
  const rawUrl = envFile.DATABASE_URL;
  if (!rawUrl) {
    console.error('DATABASE_URL не найден в fot-server/.env');
    process.exit(1);
  }
  try {
    const url = new URL(rawUrl);
    for (const key of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'ssl']) url.searchParams.delete(key);
    process.env.DATABASE_URL = url.toString();
  } catch {
    process.env.DATABASE_URL = rawUrl;
  }
  process.env.DATABASE_SSL = 'true';
  process.env.DATABASE_SSL_CA_PATH = LOCAL_CA;
}

const OUT_DIR = path.resolve(__dirname, '../temp');
/** План живёт час: иначе dry-run и apply разъезжаются по составу и по «вчера». */
const PLAN_MAX_AGE_MS = 60 * 60 * 1000;

type ScopePart = 'contractors' | 'rootless';

interface IArgs {
  input: string | null;
  /** confirmation-файл: единственный источник права гасить карту. */
  confirmations: string | null;
  plan: string | null;
  confirmPlan: string | null;
  rollback: string | null;
  scope: ScopePart[];
  org: string | null;
  limit: number | null;
  expect: number | null;
  concurrency: number;
  apply: boolean;
}

interface IOperation {
  employeeId: number;
  cardId: number;
  value: string | null;
  w26: string | null;
  format: string | null;
  startDate: string | null;
  expirationDate: string | null;
}

interface IPlanFile {
  kind: 'contractor-old-card-block-plan';
  createdAt: string;
  connection: string;
  inventoryPath: string;
  inventorySha256: string;
  confirmationsSha256: string;
  confirmedCardIds: number[];
  scope: ScopePart[];
  org: string | null;
  limit: number | null;
  contractorSigurId: number;
  controlNodes: Record<string, { id: number; parentId: number | null; descendantsHash: string }>;
  expirationTarget: string;
  operations: IOperation[];
  planHash: string;
}

function parseArgs(argv: string[]): IArgs {
  const get = (name: string): string | null => {
    const prefix = `--${name}=`;
    const found = argv.find(arg => arg.startsWith(prefix));
    return found ? found.slice(prefix.length) : null;
  };
  const scopeRaw = get('scope');
  const scope = (scopeRaw ? scopeRaw.split(',') : ['contractors', 'rootless'])
    .map(part => part.trim())
    .filter((part): part is ScopePart => part === 'contractors' || part === 'rootless');
  if (scope.length === 0) throw new Error('--scope должен содержать contractors и/или rootless');

  const num = (name: string): number | null => {
    const raw = get(name);
    if (raw === null) return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) throw new Error(`--${name} должен быть неотрицательным числом`);
    return value;
  };

  return {
    input: get('input'),
    confirmations: get('confirmations'),
    plan: get('plan'),
    confirmPlan: get('confirm-plan'),
    rollback: get('rollback'),
    scope,
    org: get('org'),
    limit: num('limit'),
    expect: num('expect'),
    concurrency: num('concurrency') ?? 1,
    apply: argv.includes('--apply'),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const util = await import('../src/services/old-card-block.util.js');
  const collect = await import('../src/services/old-card-block.collect.js');
  const { sigurService } = await import('../src/services/sigur.service.js');
  const { query } = await import('../src/config/postgres.js');
  const { resolveField } = await import('../src/services/sigur-sync-shared.js');
  const { normalizeInt } = await import('../src/services/sigur-live-admin.service.js');

  /** Точечное чтение привязки — единственный авторитетный источник состояния после записи. */
  const readBinding = async (employeeId: number, cardId: number): Promise<ILiveBinding | null> => {
    const raw = await sigurService.getCardBindings({ employeeId, cardId }) as Record<string, unknown>[];
    for (const item of raw) {
      const holder = item.holder && typeof item.holder === 'object' ? item.holder as Record<string, unknown> : null;
      const owner = normalizeInt(
        resolveField(item, 'employeeId', 'employee_id')
        ?? (holder ? resolveField(holder, 'holderId', 'holder_id', 'id') : null),
      );
      const id = normalizeInt(resolveField(item, 'cardId', 'card_id', 'id'));
      if (id !== cardId) continue;
      return {
        employeeId: owner,
        cardId: id,
        startDate: String(resolveField<string>(item, 'startDate', 'start_date', 'validFrom') ?? '').trim() || null,
        expirationDate: String(
          resolveField<string>(item, 'expirationDate', 'expiration_date', 'expiresAt', 'validTo') ?? '',
        ).trim() || null,
      };
    }
    return null;
  };

  if (args.rollback) {
    await runRollback(args, { util, sigurService, readBinding });
    return;
  }
  if (args.apply) {
    await runApply(args, {
      util, collect, sigurService, query, resolveField, normalizeInt, readBinding,
    });
    return;
  }
  await runDryRun(args, { util, collect });
}

// ── DRY-RUN ────────────────────────────────────────────────────────────────────────

async function runDryRun(
  args: IArgs,
  deps: {
    util: typeof import('../src/services/old-card-block.util.js');
    collect: typeof import('../src/services/old-card-block.collect.js');
  },
): Promise<void> {
  const { util, collect } = deps;
  console.log('=== DRY-RUN: ничего не пишется ===');
  console.log(`Скоуп: ${args.scope.join(',')}${args.org ? ` | организация: ${args.org}` : ''}`
    + `${args.limit ? ` | limit: ${args.limit}` : ''}`);
  console.log('Скоуп обязан совпадать с тем, что передан в build-white-confirmation.ts\n');
  if (!args.input) throw new Error('нужен --input=<inventory JSON>');

  const inventoryRaw = fs.readFileSync(args.input, 'utf8');
  const inventory = JSON.parse(inventoryRaw) as { inventoryComplete?: boolean; cards: IInventoryCard[] };
  if (inventory.inventoryComplete === false) throw new Error('инвентаризация помечена неполной — использовать нельзя');

  // Без confirmation-файла гасить нечего: право даёт только внешнее подтверждение.
  if (!args.confirmations) {
    const empty = await collect.collectLiveState({ requireRootless: args.scope.includes('rootless') });
    printSelection(args, empty, new Set(), util);
    console.log('\n──────────────────────────────────────────────────────────');
    console.log('  Не задан --confirmations=<файл> — к гашению 0 карт.');
    console.log('  Право гасить даёт только внешнее подтверждение конкретных карт.');
    console.log('  Соберите файл: npx tsx scripts/build-white-confirmation.ts');
    console.log('──────────────────────────────────────────────────────────');
    return;
  }

  const confirmationsRaw = fs.readFileSync(args.confirmations, 'utf8');
  const confirmationsSha256 = util.sha256(confirmationsRaw);
  const parsed = util.parseConfirmationFile(confirmationsRaw);
  if (parsed.errors.length > 0) {
    console.error('Confirmation-файл не прошёл проверку:');
    for (const error of parsed.errors.slice(0, 20)) console.error(`  • ${error}`);
    throw new Error('исправьте confirmation-файл и повторите');
  }
  const confirmations = new Map(parsed.entries.map(entry => [entry.cardId, entry]));
  console.log(`[подтверждения] карт: ${confirmations.size}, SHA-256: ${confirmationsSha256}`);

  const state = await collect.collectLiveState({
    requireRootless: args.scope.includes('rootless'),
    confirmedWhiteCardIds: new Set(confirmations.keys()),
  });

  // Идентичность каждой подтверждённой карты сверяется с живыми данными.
  const identityRejected: string[] = [];
  const allowlist = new Set<number>();
  for (const entry of parsed.entries) {
    const row = state.rows.find(item => item.cardId === entry.cardId);
    const verdict = util.verifyConfirmedIdentity(entry, row
      ? {
        cardId: row.cardId,
        value: row.value,
        w26: row.w26,
        format: row.format,
        employeeId: row.sigurEmployeeId,
      }
      : null);
    if (verdict === 'ok') allowlist.add(entry.cardId);
    else identityRejected.push(`cardId ${entry.cardId}: ${verdict}`);
  }
  if (identityRejected.length > 0) {
    console.log(`[подтверждения] отклонено по несовпадению идентичности: ${identityRejected.length}`);
    for (const line of identityRejected.slice(0, 10)) console.log(`    ${line}`);
  }

  const result = printSelection(args, state, allowlist, util);

  if (result.candidates.length === 0) {
    console.log('\nК гашению 0 карт — план не создаётся.');
    return;
  }

  const expirationTarget = util.buildExpirationTarget(new Date());
  const operations: IOperation[] = result.candidates.map(card => ({
    employeeId: card.sigurEmployeeId,
    cardId: card.cardId,
    value: card.value,
    w26: card.w26,
    format: card.format,
    startDate: card.startDate,
    expirationDate: card.expirationDate,
  }));

  const planWithoutHash = {
    kind: 'contractor-old-card-block-plan' as const,
    createdAt: new Date().toISOString(),
    connection: state.connection,
    inventoryPath: path.resolve(args.input),
    inventorySha256: util.sha256(inventoryRaw),
    confirmationsSha256,
    confirmedCardIds: [...allowlist].sort((left, right) => left - right),
    scope: args.scope,
    org: args.org,
    limit: args.limit,
    contractorSigurId: state.contractorSigurId,
    controlNodes: state.controlNodes,
    expirationTarget,
    operations,
  };
  const planHash = util.buildPlanHash(planWithoutHash);
  const plan: IPlanFile = { ...planWithoutHash, planHash };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const suffix = args.org || args.limit ? 'pilot-' : '';
  const planPath = path.join(OUT_DIR, `block-plan-${suffix}${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf8');

  console.log(`\nПлан: ${planPath}`);
  console.log(`planHash: ${planHash}`);
  console.log(`Целевая дата окончания: ${expirationTarget}`);
  // Одной строкой: перенос через "\" ломается в PowerShell, а именно там это запускают.
  console.log('\nБоевой запуск (план живёт 60 минут). Команда ОДНОЙ строкой:');
  console.log(`npx tsx scripts/block-contractor-old-cards.ts "--plan=${planPath}" `
    + `"--confirmations=${args.confirmations}" "--confirm-plan=${planHash}" `
    + `--apply "--expect=${operations.length}"`);
}

function printSelection(
  args: IArgs,
  state: ILiveState,
  allowlist: ReadonlySet<number>,
  util: typeof import('../src/services/old-card-block.util.js'),
): ReturnType<typeof util.selectBlockCandidates> {
  const result = util.selectBlockCandidates({
    cards: state.rows,
    allowlist,
    denylist: state.denylist,
    employeesWithNewCard: state.employeesWithNewCard,
    excludedBranchCardIds: state.excludedBranchCardIds,
    options: { scope: args.scope, org: args.org, limit: args.limit, now: Date.now() },
  });

  console.log('\n── Отбор ──');
  console.log(`к гашению: ${result.candidates.length}`);
  if (result.droppedByLimit > 0) console.log(`отброшено по --limit: ${result.droppedByLimit}`);
  const interesting = (Object.entries(result.skipCounts) as Array<[SkipReason, number]>)
    .filter(([reason, count]) => count > 0 && reason !== 'not_in_allowlist')
    .sort((left, right) => right[1] - left[1]);
  for (const [reason, count] of interesting) console.log(`  отсеяно ${reason}: ${count}`);

  const byOrg = new Map<string, number>();
  for (const card of result.candidates) {
    const key = `${card.scopeBucket === 'rootless' ? '(корень)' : card.orgName ?? '—'}`;
    byOrg.set(key, (byOrg.get(key) ?? 0) + 1);
  }
  console.log('\n── По организациям ──');
  for (const [org, count] of [...byOrg.entries()].sort((left, right) => right[1] - left[1]).slice(0, 30)) {
    console.log(`  ${org}: ${count}`);
  }
  return result;
}

// ── APPLY ──────────────────────────────────────────────────────────────────────────

async function runApply(
  args: IArgs,
  deps: {
    util: typeof import('../src/services/old-card-block.util.js');
    collect: typeof import('../src/services/old-card-block.collect.js');
    sigurService: typeof import('../src/services/sigur.service.js')['sigurService'];
    query: typeof import('../src/config/postgres.js')['query'];
    resolveField: typeof import('../src/services/sigur-sync-shared.js')['resolveField'];
    normalizeInt: typeof import('../src/services/sigur-live-admin.service.js')['normalizeInt'];
    readBinding: (employeeId: number, cardId: number) => Promise<ILiveBinding | null>;
  },
): Promise<void> {
  const { util, collect, sigurService, query, resolveField, normalizeInt, readBinding } = deps;
  console.log('=== БОЕВОЙ ПРОГОН ===\n');
  if (!args.plan) throw new Error('--apply требует --plan=<block-plan.json>');
  if (!args.confirmPlan) throw new Error('--apply требует --confirm-plan=<planHash>');
  if (!args.confirmations) throw new Error('--apply требует --confirmations=<файл подтверждений>');

  const plan = JSON.parse(fs.readFileSync(args.plan, 'utf8')) as IPlanFile;
  if (plan.kind !== 'contractor-old-card-block-plan') throw new Error('это не файл плана гашения');

  // Тот же confirmation-файл, что и при dry-run: сверяем содержимое по хешу.
  const confirmationsRaw = fs.readFileSync(args.confirmations, 'utf8');
  if (util.sha256(confirmationsRaw) !== plan.confirmationsSha256) {
    throw new Error('confirmation-файл отличается от использованного в dry-run (SHA-256 не сходится) — стоп');
  }
  const parsed = util.parseConfirmationFile(confirmationsRaw);
  if (parsed.errors.length > 0) throw new Error(`confirmation-файл повреждён: ${parsed.errors[0]}`);
  const confirmations = new Map(parsed.entries.map(entry => [entry.cardId, entry]));
  console.log(`[подтверждения] карт: ${confirmations.size}, хеш совпал`);

  const { planHash: storedHash, ...planBody } = plan;
  if (util.buildPlanHash(planBody) !== storedHash) throw new Error('файл плана повреждён: planHash не сходится');
  if (storedHash !== args.confirmPlan) throw new Error('--confirm-plan не совпадает с planHash плана');

  const ageMs = Date.now() - Date.parse(plan.createdAt);
  if (!Number.isFinite(ageMs) || ageMs > PLAN_MAX_AGE_MS) {
    throw new Error(`план старше ${PLAN_MAX_AGE_MS / 60000} минут — сделайте новый dry-run`);
  }
  console.log(`[план] операций: ${plan.operations.length}, возраст ${Math.round(ageMs / 1000)} с`);
  console.log(`[план] scope=${plan.scope.join(',')} org=${plan.org ?? '—'} limit=${plan.limit ?? '—'}`);

  // ── Фаза A: живой preflight ──────────────────────────────────────────────────────
  const needRootless = plan.scope.includes('rootless');
  const state = await collect.collectLiveState({
    requireRootless: needRootless,
    confirmedWhiteCardIds: new Set(confirmations.keys()),
  });

  if (state.contractorSigurId !== plan.contractorSigurId) {
    throw new Error('корень «Подрядные организации» сменил Sigur ID — стоп');
  }
  for (const [name, planned] of Object.entries(plan.controlNodes)) {
    const verdict = util.compareControlNode(planned, state.controlNodes[name] ?? null);
    if (verdict !== 'ok') throw new Error(`контрольный узел "${name}": ${verdict} — стоп, нужен новый dry-run`);
  }
  console.log('[preflight] контрольные узлы совпали');

  // Пересечение операций плана с исключёнными ветками обязано быть пустым.
  const collision = plan.operations.filter(operation => state.excludedBranchCardIds.has(operation.cardId));
  if (collision.length > 0) {
    throw new Error(
      `в плане ${collision.length} карт из исключённых веток (СУ-10 / СМ / аномалии): `
      + `${collision.slice(0, 5).map(item => item.cardId).join(', ')} — стоп`,
    );
  }
  console.log('[preflight] пересечение с исключёнными ветками пусто');

  // Идентичность подтверждённых карт сверяется заново по живым данным.
  const identityOk = new Set<number>();
  for (const entry of parsed.entries) {
    const row = state.rows.find(item => item.cardId === entry.cardId);
    const verdict = util.verifyConfirmedIdentity(entry, row
      ? {
        cardId: row.cardId,
        value: row.value,
        w26: row.w26,
        format: row.format,
        employeeId: row.sigurEmployeeId,
      }
      : null);
    if (verdict === 'ok') identityOk.add(entry.cardId);
  }
  console.log(`[preflight] идентичность подтверждена у ${identityOk.size} из ${confirmations.size} карт`);

  const result = util.selectBlockCandidates({
    cards: state.rows,
    allowlist: identityOk,
    denylist: state.denylist,
    employeesWithNewCard: state.employeesWithNewCard,
    excludedBranchCardIds: state.excludedBranchCardIds,
    options: { scope: plan.scope, org: plan.org, limit: plan.limit, now: Date.now() },
  });

  const liveOperations: IOperation[] = result.candidates.map(card => ({
    employeeId: card.sigurEmployeeId,
    cardId: card.cardId,
    value: card.value,
    w26: card.w26,
    format: card.format,
    startDate: card.startDate,
    expirationDate: card.expirationDate,
  }));
  if (util.canonicalJson(liveOperations) !== util.canonicalJson(plan.operations)) {
    console.error(`[preflight] план: ${plan.operations.length} операций, живой пересчёт: ${liveOperations.length}`);
    throw new Error('состав операций изменился с момента dry-run — стоп, нужен новый план');
  }
  if (args.expect === null) throw new Error('--apply требует --expect=<N>');
  if (args.expect !== liveOperations.length) {
    throw new Error(`--expect=${args.expect}, а к гашению ${liveOperations.length} — стоп`);
  }
  console.log(`[preflight] состав совпал: ${liveOperations.length} операций\n`);

  // ── Фаза B: запись ───────────────────────────────────────────────────────────────
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const journalPath = path.join(OUT_DIR, `block-old-cards-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
  const journal = fs.openSync(journalPath, 'a');
  const writeJournal = (entry: Record<string, unknown>): void => {
    fs.writeSync(journal, `${JSON.stringify(entry)}\n`);
    fs.fsyncSync(journal);
  };

  const counters: Record<string, number> = {};
  const bump = (key: string): void => { counters[key] = (counters[key] ?? 0) + 1; };

  /** Настоящая ошибка, а не «что-то пошло не так»: тип, текст и первый кадр стека. */
  const describeError = (error: unknown): string => {
    if (!(error instanceof Error)) return String(error);
    const frame = (error.stack ?? '').split('\n').map(line => line.trim()).find(line => line.startsWith('at '));
    return `${error.name}: ${error.message}${frame ? ` (${frame})` : ''}`;
  };

  const passHexByEmployee = new Map<number, boolean>();
  for (const operation of liveOperations) passHexByEmployee.set(operation.employeeId, false);

  const runOne = async (operation: IOperation, index: number): Promise<void> => {
    const label = `[${index + 1}/${liveOperations.length}] emp=${operation.employeeId} card=${operation.cardId}`;

    // Гард 5: отсутствие новой карты доказываем СВЕЖИМИ запросами по этому человеку.
    let employeeRaw: Record<string, unknown>;
    let freshBindings: Record<string, unknown>[];
    let passRows: Array<{ pass_number: string; status: string }>;
    try {
      [employeeRaw, freshBindings, passRows] = await Promise.all([
        sigurService.getEmployeeById(operation.employeeId) as Promise<Record<string, unknown>>,
        sigurService.getCardBindings({ employeeId: operation.employeeId }) as Promise<Record<string, unknown>[]>,
        // ЛЮБАЯ строка модуля, включая revoked: она доказывает, что карта проходила
        // через модуль. Проверять card_hex_uid недостаточно — он бывает пустым.
        query<{ pass_number: string; status: string }>(
          'SELECT pass_number, status FROM contractor_passes WHERE sigur_employee_id = $1',
          [operation.employeeId],
        ),
      ]);
    } catch (error) {
      bump('skip_unknown_new_status');
      console.warn(`${label} — skip_unknown_new_status: ${(error as Error).message}`);
      return;
    }

    const employeeName = String(resolveField<string>(employeeRaw, 'name', 'fullName', 'full_name') ?? '');
    if (util.hasFotPoolNote(String(resolveField<string>(employeeRaw, 'description', 'note', 'comment') ?? ''))) {
      bump('skipped_has_new_card');
      console.warn(`${label} — skipped_has_new_card: FOT-POOL в примечании профиля`);
      return;
    }
    if (collect.POOL_PLACEHOLDER_RE.test(employeeName)) {
      bump('skipped_has_new_card');
      console.warn(`${label} — skipped_has_new_card: профиль-плейсхолдер «${employeeName.trim()}»`);
      return;
    }
    if (passRows.length > 0) {
      bump('skipped_has_new_card');
      console.warn(`${label} — skipped_has_new_card: у сотрудника ${passRows.length} строк модуля `
        + `(${passRows.map(row => `${row.pass_number}/${row.status}`).slice(0, 3).join(', ')})`);
      return;
    }

    // Гард 6-7: скоуп пересчитывается по живому профилю.
    const departmentId = util.normalizeDepartmentId(
      resolveField(employeeRaw, 'departmentId', 'department_id', 'departmentID', 'department'),
    );
    const bucket = util.resolveScopeBucket({
      departmentId,
      isKnownDepartment: typeof departmentId === 'number' && state.departments.some(dept => dept.id === departmentId),
      contractorDescendants: state.contractorDescendants,
      excludedDescendants: state.excludedDescendants,
    });
    if (bucket === 'excluded' || bucket === 'anomaly' || !plan.scope.includes(bucket as ScopePart)) {
      bump('skip_scope_drift');
      console.warn(`${label} — skip_scope_drift: сотрудник теперь в "${bucket}"`);
      return;
    }

    // Ни одна из ЕГО карт не должна быть связана с модулем выдачи.
    let unknownCard = false;
    let hasNew = false;
    let current: ILiveBinding | null = null;
    for (const raw of freshBindings) {
      const cardId = normalizeInt(resolveField(raw, 'cardId', 'card_id', 'id'));
      if (!cardId) continue;
      if (state.excludedBranchCardIds.has(cardId)) { hasNew = true; continue; }
      const facts = state.cardFactsById.get(cardId);
      if (!facts) { unknownCard = true; continue; }
      if (util.classifyCardGeneration(facts, identityOk).generation === 'module_linked') hasNew = true;
      if (cardId === operation.cardId) {
        const holder = raw.holder && typeof raw.holder === 'object' ? raw.holder as Record<string, unknown> : null;
        current = {
          employeeId: normalizeInt(
            resolveField(raw, 'employeeId', 'employee_id')
            ?? (holder ? resolveField(holder, 'holderId', 'holder_id', 'id') : null),
          ),
          cardId,
          startDate: String(resolveField<string>(raw, 'startDate', 'start_date', 'validFrom') ?? '').trim() || null,
          expirationDate: String(
            resolveField<string>(raw, 'expirationDate', 'expiration_date', 'expiresAt', 'validTo') ?? '',
          ).trim() || null,
        };
      }
    }
    if (hasNew) {
      bump('skipped_has_new_card');
      console.warn(`${label} — skipped_has_new_card: у сотрудника карта, связанная с модулем`);
      return;
    }
    // Последний рубеж: сама карта обязана быть в подтверждённых и вне исключённых веток.
    if (!identityOk.has(operation.cardId) || state.excludedBranchCardIds.has(operation.cardId)) {
      bump('skip_not_confirmed');
      console.warn(`${label} — skip_not_confirmed: подтверждение не действует на момент записи`);
      return;
    }

    if (unknownCard) {
      bump('skip_unknown_new_status');
      console.warn(`${label} — skip_unknown_new_status: карта сотрудника отсутствует в каталоге`);
      return;
    }

    // Гард 8-10: привязка на месте, даты те же, срок ещё не истёк.
    if (!current) { bump('skip_binding_gone'); console.warn(`${label} — skip_binding_gone`); return; }
    if (current.employeeId !== operation.employeeId) {
      bump('skip_owner_drift'); console.warn(`${label} — skip_owner_drift`); return;
    }
    if (!util.datesEqual(current.startDate, operation.startDate)
      || !util.datesEqual(current.expirationDate, operation.expirationDate)) {
      bump('skip_dates_drift'); console.warn(`${label} — skip_dates_drift`); return;
    }
    if (!current.expirationDate) {
      bump('skipped_no_expiration_unrevertable'); console.warn(`${label} — skipped_no_expiration_unrevertable`); return;
    }

    // Идентичность сверяется СВЕЖИМ чтением каталога Sigur, а не снимком preflight.
    const entry = confirmations.get(operation.cardId);
    if (!entry) { bump('skip_not_confirmed'); console.warn(`${label} — skip_not_confirmed`); return; }
    // try/catch — ТОЛЬКО вокруг запроса. Разбор ответа наружу: иначе ошибка разбора
    // снова замаскируется под «Sigur недоступен» и остановит гашение целиком.
    let found: Awaited<ReturnType<typeof sigurService.findCardByCandidates>>;
    try {
      found = await sigurService.findCardByCandidates([entry.value, entry.w26]);
    } catch (error) {
      bump('skip_unknown_new_status');
      console.warn(`${label} — skip_unknown_new_status: запрос карты в Sigur не удался: ${describeError(error)}`);
      return;
    }

    const exact = found.matches.find(
      raw => normalizeInt(resolveField(raw, 'id', 'ID', 'cardId', 'card_id')) === operation.cardId,
    );
    let liveIdentity: ReturnType<typeof util.buildLiveCardIdentity> = null;
    if (exact) {
      liveIdentity = util.buildLiveCardIdentity(
        exact,
        operation.cardId,
        current.employeeId ?? operation.employeeId,
        operation.format,
      );
      // Карта найдена, но W26 не выводится — состояние неопределённое, гасить нельзя.
      if (!liveIdentity) {
        bump('skip_identity_underivable');
        console.warn(
          `${label} — skip_identity_underivable: W26 не выводится`
          + ` (value=${JSON.stringify(resolveField(exact, 'value', 'cardValue', 'card_value') ?? null)},`
          + ` formattedValue=${JSON.stringify(resolveField(exact, 'formattedValue', 'formatted_value') ?? null)},`
          + ` format=${JSON.stringify(resolveField(exact, 'format', 'Format', 'cardFormat') ?? null)})`,
        );
        return;
      }
    } else {
      console.warn(
        `${label} — карта не найдена в каталоге по подтверждению`
        + ` (tried=${JSON.stringify(found.tried)}, matches=${found.matches.length})`,
      );
    }
    const identityVerdict = util.verifyConfirmedIdentity(entry, liveIdentity);
    if (identityVerdict !== 'ok') {
      bump(`skip_identity_${identityVerdict}`);
      console.warn(`${label} — skip_identity_${identityVerdict}`);
      return;
    }

    const base = {
      employeeId: operation.employeeId,
      cardId: operation.cardId,
      format: operation.format,
      startDateBefore: current.startDate,
      expirationDateBefore: current.expirationDate,
      expirationDateTarget: plan.expirationTarget,
    };
    writeJournal({ event: 'prepared', at: new Date().toISOString(), ...base });

    let writeError: string | null = null;
    try {
      if (current.startDate) {
        await sigurService.patchEmployeeCardBinding(
          operation.employeeId,
          operation.cardId,
          new Date(current.startDate).toISOString(),
          plan.expirationTarget,
          undefined,
          operation.format ?? undefined,
        );
      } else {
        await sigurService.updateEmployeeCardBindingExpiration(
          operation.employeeId,
          operation.cardId,
          plan.expirationTarget,
        );
      }
    } catch (error) {
      writeError = (error as Error).message;
    }

    // Исключение НЕ означает, что записи не было: клиент ретраит put/patch на 5xx и таймаутах.
    let live: ILiveBinding | null = null;
    let getFailed = false;
    try {
      live = await readBinding(operation.employeeId, operation.cardId);
    } catch {
      getFailed = true;
    }
    const outcome: WriteOutcome = util.classifyWriteOutcome({
      live,
      getFailed,
      targetExpiration: plan.expirationTarget,
      beforeExpiration: current.expirationDate,
    });
    bump(outcome);
    writeJournal({
      event: outcome,
      at: new Date().toISOString(),
      ...base,
      expirationDateAfter: live?.expirationDate ?? null,
      error: writeError,
    });
    if (outcome !== 'committed') console.warn(`${label} — ${outcome}${writeError ? `: ${writeError}` : ''}`);
  };

  const concurrency = Math.max(1, Math.min(4, args.concurrency));
  console.log(`[запись] параллелизм: ${concurrency}, журнал: ${journalPath}\n`);
  let cursor = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < liveOperations.length) {
      const index = cursor++;
      await runOne(liveOperations[index], index);
    }
  }));
  fs.closeSync(journal);

  console.log('\n── Итог ──');
  for (const [key, count] of Object.entries(counters).sort((left, right) => right[1] - left[1])) {
    console.log(`  ${key}: ${count}`);
  }
  console.log(`\nЖурнал этого прогона: ${journalPath}`);
  console.log('Откат ИМЕННО этого прогона — берите путь выше, не автоподбор свежего файла:');
  console.log(`npx tsx scripts/block-contractor-old-cards.ts "--rollback=${journalPath}" --apply`);
  console.log('\nВНИМАНИЕ: прежний план теперь недействителен — состав изменился.');
  console.log('Для следующей партии нужен новый dry-run и новый план.');
}

// ── ROLLBACK ───────────────────────────────────────────────────────────────────────

async function runRollback(
  args: IArgs,
  deps: {
    util: typeof import('../src/services/old-card-block.util.js');
    sigurService: typeof import('../src/services/sigur.service.js')['sigurService'];
    readBinding: (employeeId: number, cardId: number) => Promise<ILiveBinding | null>;
  },
): Promise<void> {
  const { util, sigurService, readBinding } = deps;
  console.log(`=== ОТКАТ${args.apply ? '' : ' (dry-run)'} ===\n`);

  const lines = fs.readFileSync(args.rollback!, 'utf8').split(/\r?\n/).filter(Boolean);
  const events = lines.map(line => JSON.parse(line) as Record<string, unknown>);

  interface IEntry {
    employeeId: number;
    cardId: number;
    format: string | null;
    startDateBefore: string | null;
    expirationDateBefore: string | null;
    expirationDateTarget: string;
    expirationDateAfter: string | null;
    outcome: string;
  }
  const byKey = new Map<string, IEntry>();
  for (const event of events) {
    const employeeId = Number(event.employeeId);
    const cardId = Number(event.cardId);
    const key = `${employeeId}:${cardId}`;
    const existing = byKey.get(key);
    const entry: IEntry = {
      employeeId,
      cardId,
      format: (event.format as string | null) ?? existing?.format ?? null,
      startDateBefore: (event.startDateBefore as string | null) ?? existing?.startDateBefore ?? null,
      expirationDateBefore: (event.expirationDateBefore as string | null) ?? existing?.expirationDateBefore ?? null,
      expirationDateTarget: (event.expirationDateTarget as string) ?? existing?.expirationDateTarget ?? '',
      expirationDateAfter: (event.expirationDateAfter as string | null) ?? existing?.expirationDateAfter ?? null,
      outcome: String(event.event),
    };
    byKey.set(key, entry);
  }

  const counters: Record<string, number> = {};
  const bump = (key: string): void => { counters[key] = (counters[key] ?? 0) + 1; };
  const manual: string[] = [];

  // Порядок обратный записи, строго последовательно.
  for (const entry of [...byKey.values()].reverse()) {
    const label = `emp=${entry.employeeId} card=${entry.cardId}`;

    // prepared без пары и unknown — исход неизвестен, разбираем тем же reconciliation.
    let live: ILiveBinding | null;
    try {
      live = await readBinding(entry.employeeId, entry.cardId);
    } catch (error) {
      bump('read_failed');
      manual.push(`${label}: GET упал (${(error as Error).message})`);
      continue;
    }

    if (entry.outcome === 'prepared' || entry.outcome === 'unknown') {
      const outcome = util.classifyWriteOutcome({
        live,
        getFailed: false,
        targetExpiration: entry.expirationDateTarget,
        beforeExpiration: entry.expirationDateBefore,
      });
      if (outcome === 'not_applied') { bump('not_applied_nothing_to_do'); continue; }
      if (outcome === 'unknown') { bump('unknown'); manual.push(`${label}: состояние третье, разобрать вручную`); continue; }
      entry.expirationDateAfter = entry.expirationDateTarget;
    } else if (entry.outcome !== 'committed') {
      bump(`skip_${entry.outcome}`);
      continue;
    }

    const verdict = util.evaluateRollback({
      employeeId: entry.employeeId,
      cardId: entry.cardId,
      startDateBefore: entry.startDateBefore,
      expirationDateBefore: entry.expirationDateBefore,
      expirationDateAfter: entry.expirationDateAfter,
    }, live);

    if (verdict !== 'ok') {
      bump(verdict);
      if (verdict !== 'already_restored') manual.push(`${label}: ${verdict}`);
      continue;
    }
    if (!args.apply) { bump('would_restore'); continue; }

    try {
      if (entry.startDateBefore) {
        await sigurService.patchEmployeeCardBinding(
          entry.employeeId,
          entry.cardId,
          new Date(entry.startDateBefore).toISOString(),
          entry.expirationDateBefore!,
          undefined,
          entry.format ?? undefined,
        );
      } else {
        await sigurService.updateEmployeeCardBindingExpiration(
          entry.employeeId,
          entry.cardId,
          entry.expirationDateBefore!,
        );
      }
      bump('restored');
    } catch (error) {
      bump('restore_failed');
      manual.push(`${label}: запись отката упала (${(error as Error).message})`);
    }
  }

  console.log('── Итог отката ──');
  for (const [key, count] of Object.entries(counters).sort((left, right) => right[1] - left[1])) {
    console.log(`  ${key}: ${count}`);
  }
  if (manual.length > 0) {
    console.log('\n── Ручной разбор ──');
    for (const line of manual) console.log(`  • ${line}`);
  }
  if (!args.apply) console.log('\nЭто dry-run отката. Повторите с --apply.');
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    const err = error as Error;
    console.error('\nОшибка:', err?.stack ?? err?.message ?? error);
    process.exit(1);
  });
