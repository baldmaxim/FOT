/**
 * READ-ONLY аудит гашения пропусков старого образца.
 *
 * Отвечает на три вопроса и ни на один не верит на слово счётчикам прогона:
 *   A. сработало ли — каждая карта из журналов перечитывается в Sigur живьём;
 *   B. кого задели — идентичность карты сверяется с confirmation-файлом того же прогона;
 *   C. что осталось — свежий отбор кандидатов тем же selectBlockCandidates, что и в бою;
 *   D. проходы после гашения — индикативно, по skud_events.
 *
 * Пишущих вызовов здесь нет в принципе: ни patchEmployeeCardBinding, ни --apply.
 *
 * Запуск:
 *   npx tsx scripts/verify-old-card-block.ts \
 *     --runs=<журнал>::<план>::<confirmation>[,<журнал>::<план>::<confirmation>] \
 *     --deleted-blacklist=temp/deleted-passes-blacklist.json --scope=contractors
 *
 * Коды возврата: 1 — аномалии, 2 — незакрытый хвост, 3 — PARTIAL, 0 — аудит чист.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type {
  IJournalRecord,
  IPlanOperation,
  IPlanSummary,
  ILiveBinding,
  VerificationVerdict,
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
  if (rawUrl) {
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
}

const OUT_DIR = path.resolve(__dirname, '../temp');

type ScopePart = 'contractors' | 'rootless';
type CoveragePolicy = 'next-batch' | 'replay-plan';

interface IRunInput {
  journalPath: string;
  planPath: string | null;
  confirmationsPath: string | null;
}

interface IArgs {
  runs: IRunInput[];
  deletedBlacklist: string | null;
  scope: ScopePart[];
  coveragePolicy: CoveragePolicy;
  expectRemaining: number | null;
  passesSince: string | null;
  limit: number | null;
  concurrency: number;
  skipCoverage: boolean;
}

function parseArgs(argv: string[]): IArgs {
  const get = (name: string): string | null => {
    const prefix = `--${name}=`;
    const found = argv.find(arg => arg.startsWith(prefix));
    return found ? found.slice(prefix.length) : null;
  };

  const runsRaw = get('runs');
  if (!runsRaw) throw new Error('нужен --runs=<журнал>::<план>::<confirmation>[,...]');
  const runs = runsRaw.split(',').map(chunk => {
    const [journalPath, planPath, confirmationsPath] = chunk.split('::').map(part => part.trim());
    if (!journalPath) throw new Error(`--runs: пустой путь к журналу в "${chunk}"`);
    return {
      journalPath,
      planPath: planPath || null,
      confirmationsPath: confirmationsPath || null,
    };
  });

  const scopeRaw = get('scope');
  const scope = (scopeRaw ? scopeRaw.split(',') : ['contractors'])
    .map(part => part.trim())
    .filter((part): part is ScopePart => part === 'contractors' || part === 'rootless');
  if (scope.length === 0) throw new Error('--scope должен содержать contractors и/или rootless');

  const policyRaw = get('coverage-policy') ?? 'next-batch';
  if (policyRaw !== 'next-batch' && policyRaw !== 'replay-plan') {
    throw new Error('--coverage-policy: допустимы next-batch и replay-plan');
  }

  const num = (name: string): number | null => {
    const raw = get(name);
    if (raw === null) return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) throw new Error(`--${name} должен быть неотрицательным числом`);
    return value;
  };

  const passesSince = get('passes-since');
  if (passesSince !== null && Number.isNaN(Date.parse(passesSince))) {
    throw new Error(`--passes-since: "${passesSince}" не разбирается как дата`);
  }

  return {
    runs,
    deletedBlacklist: get('deleted-blacklist'),
    scope,
    coveragePolicy: policyRaw,
    expectRemaining: num('expect-remaining'),
    passesSince,
    limit: num('limit'),
    concurrency: num('concurrency') ?? 4,
    skipCoverage: argv.includes('--skip-coverage'),
  };
}

interface IVerificationRow {
  runFile: string;
  employeeId: number;
  cardId: number;
  w26: string | null;
  journalOutcome: string;
  verdict: VerificationVerdict;
  identityVerdict: string | null;
  expirationBefore: string | null;
  expirationTarget: string;
  liveExpiration: string | null;
  liveStartDate: string | null;
  liveOwner: number | null;
  syntheticStart: boolean;
  reattempted: boolean;
  note: string | null;
}

const describeError = (error: unknown): string => (
  error instanceof Error ? `${error.name}: ${error.message}` : String(error)
);

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const util = await import('../src/services/old-card-block.util.js');
  const collect = await import('../src/services/old-card-block.collect.js');
  const { sigurService } = await import('../src/services/sigur.service.js');
  const { query } = await import('../src/config/postgres.js');
  const { resolveField } = await import('../src/services/sigur-sync-shared.js');
  const { normalizeInt } = await import('../src/services/sigur-live-admin.service.js');

  const startedAt = new Date();
  console.log('=== Аудит гашения пропусков старого образца (READ-ONLY) ===\n');

  // ── Чтение прогонов: журнал + план + confirmation ────────────────────────────────
  // Файлы разбираются ДО обращения к Sigur: битый журнал должен ронять аудит сразу,
  // а не после нескольких сотен запросов.
  const fatals: string[] = [];
  const partialReasons: string[] = [];
  const allEntries: ReturnType<typeof util.parseJournal> = [];
  const confirmationsByFile = new Map<string, Map<number, ReturnType<typeof util.parseConfirmationFile>['entries'][number]>>();
  const plansByFile = new Map<string, IPlanSummary>();
  const header: Record<string, unknown>[] = [];

  for (const run of args.runs) {
    const journalText = fs.readFileSync(run.journalPath, 'utf8');
    const entries = util.parseJournal(run.journalPath, journalText);
    allEntries.push(...entries);

    const info: Record<string, unknown> = {
      journal: run.journalPath,
      journalSha256: util.sha256(journalText),
      events: entries.length,
    };

    if (run.planPath && run.confirmationsPath) {
      const planText = fs.readFileSync(run.planPath, 'utf8');
      const confirmationsText = fs.readFileSync(run.confirmationsPath, 'utf8');
      const plan = JSON.parse(planText) as IPlanSummary & { confirmationsSha256: string };
      const parsedConfirmations = util.parseConfirmationFile(confirmationsText);
      if (parsedConfirmations.errors.length > 0) {
        fatals.push(`${run.confirmationsPath}: ${parsedConfirmations.errors.slice(0, 3).join('; ')}`);
      }
      confirmationsByFile.set(
        run.journalPath,
        new Map(parsedConfirmations.entries.map(entry => [entry.cardId, entry])),
      );
      plansByFile.set(run.journalPath, plan);
      info.plan = run.planPath;
      info.planHash = plan.planHash;
      info.confirmations = run.confirmationsPath;
      info.confirmationsSha256 = util.sha256(confirmationsText);
      info.planOperations = plan.operations.length;
    } else {
      partialReasons.push(`${run.journalPath}: прогон передан без плана/подтверждений`);
    }
    header.push(info);
    console.log(`[прогон] ${run.journalPath}: событий ${entries.length}${run.planPath ? `, план ${run.planPath}` : ' — БЕЗ ПЛАНА'}`);
  }

  const merged = util.mergeJournalEvents(allEntries);
  console.log(`[журналы] карт в свёртке: ${merged.records.size}`);

  const connection = await sigurService.getBackgroundConnectionType();
  console.log(`[sigur] контур: ${connection}\n`);

  // ── Сверка «план ↔ журнал» ───────────────────────────────────────────────────────
  const orphanOperations: Array<{ runFile: string; operation: IPlanOperation }> = [];
  for (const [journalPath, plan] of plansByFile) {
    const planText = fs.readFileSync(args.runs.find(run => run.journalPath === journalPath)!.planPath!, 'utf8');
    const planPayload = JSON.parse(planText) as Record<string, unknown>;
    const confirmationsPath = args.runs.find(run => run.journalPath === journalPath)!.confirmationsPath!;
    const match = util.matchJournalToPlan({
      runLabel: path.basename(journalPath),
      plan,
      recomputedPlanHash: util.buildPlanHash(planPayload),
      confirmationsSha256: util.sha256(fs.readFileSync(confirmationsPath, 'utf8')),
      planConfirmationsSha256: String(planPayload.confirmationsSha256 ?? ''),
      liveConnection: connection,
      auditScope: args.scope,
      records: merged.byFile.get(journalPath) ?? [],
    });
    fatals.push(...match.fatals);
    for (const record of match.unknownInPlan) {
      fatals.push(`${path.basename(journalPath)}: карта ${record.cardId} есть в журнале, но не в плане`);
    }
    for (const operation of match.missingInJournal) {
      orphanOperations.push({ runFile: journalPath, operation });
    }
  }
  const orphanReport = { total: orphanOperations.length, closedByOtherRun: 0 };

  // ── A. Живая перепроверка + B. идентичность ──────────────────────────────────────
  interface ITask {
    runFile: string;
    employeeId: number;
    cardId: number;
    expirationTarget: string;
    expirationBefore: string | null;
    startDateTarget: string | null;
    outcome: 'committed' | 'not_applied' | 'unknown' | null;
    format: string | null;
    preparedAt: string | null;
    reattempted: boolean;
    fromPlanOnly: boolean;
  }

  const tasks: ITask[] = [...merged.records.values()].map((record: IJournalRecord) => ({
    runFile: record.file,
    employeeId: record.employeeId,
    cardId: record.cardId,
    expirationTarget: record.expirationDateTarget,
    expirationBefore: record.expirationDateBefore,
    startDateTarget: record.startDateTarget,
    outcome: record.outcome,
    format: record.format,
    preparedAt: record.preparedAt,
    reattempted: record.reattempted,
    fromPlanOnly: false,
  }));

  // Операция без журнала СВОЕГО прогона — ещё не проблема: карту мог погасить следующий
  // прогон по своему плану, и тогда авторитетна его запись. Проверять такую карту дважды
  // нельзя: у прежнего плана другая целевая дата, и живое состояние выглядело бы как
  // third_state. В хвост идут только те, чьей записи нет ни в одном журнале.
  for (const { runFile, operation } of orphanOperations) {
    if (merged.records.has(`${operation.employeeId}:${operation.cardId}`)) {
      orphanReport.closedByOtherRun += 1;
      continue;
    }
    const plan = plansByFile.get(runFile)!;
    tasks.push({
      runFile,
      employeeId: operation.employeeId,
      cardId: operation.cardId,
      expirationTarget: plan.expirationTarget,
      expirationBefore: operation.expirationDate,
      startDateTarget: operation.startDate ? null : plan.syntheticStartDate,
      outcome: null,
      format: operation.format ?? null,
      preparedAt: null,
      reattempted: false,
      fromPlanOnly: true,
    });
  }

  if (orphanReport.total > 0) {
    console.log(
      `[план↔журнал] операций без записи в своём журнале: ${orphanReport.total}`
      + ` (из них закрыты другим прогоном: ${orphanReport.closedByOtherRun},`
      + ` проверяются живьём: ${orphanReport.total - orphanReport.closedByOtherRun})\n`,
    );
  }

  tasks.sort((left, right) => left.cardId - right.cardId);
  const selected = args.limit && args.limit > 0 ? tasks.slice(0, args.limit) : tasks;
  if (selected.length < tasks.length) {
    partialReasons.push(`--limit=${args.limit}: проверено ${selected.length} карт из ${tasks.length}`);
  }
  console.log(`[живая проверка] карт: ${selected.length}, параллелизм: ${Math.max(1, Math.min(4, args.concurrency))}\n`);

  const rows: IVerificationRow[] = [];
  const verdictCounts: Record<string, number> = {};
  const bump = (key: string): void => { verdictCounts[key] = (verdictCounts[key] ?? 0) + 1; };

  const runOne = async (task: ITask): Promise<void> => {
    let bindings: ILiveBinding[] = [];
    let readFailed = false;
    try {
      bindings = await collect.readLiveBindingsByCard(task.cardId, connection);
    } catch {
      readFailed = true;
    }
    const verdict = util.classifyBlockVerification({
      expected: {
        employeeId: task.employeeId,
        cardId: task.cardId,
        expirationTarget: task.expirationTarget,
        expirationBefore: task.expirationBefore,
        startDateTarget: task.startDateTarget,
        outcome: task.outcome,
      },
      live: { readFailed, bindings },
    });

    // B. Идентичность: подтверждение обязано описывать ту же карту, что живёт в каталоге.
    const confirmation = confirmationsByFile.get(task.runFile)?.get(task.cardId) ?? null;
    let identityVerdict: string | null = null;
    if (confirmation && !readFailed && bindings.length === 1) {
      try {
        const found = await sigurService.findCardByCandidates([confirmation.value, confirmation.w26], connection);
        const exact = found.matches.find(
          raw => normalizeInt(resolveField(raw, 'id', 'ID', 'cardId', 'card_id')) === task.cardId,
        );
        const owner = bindings[0].employeeId ?? task.employeeId;
        const identity = exact ? util.buildLiveCardIdentity(exact, task.cardId, owner, task.format) : null;
        identityVerdict = exact
          ? (identity ? util.verifyConfirmedIdentity(confirmation, identity) : 'identity_underivable')
          : 'card_not_found';
      } catch (error) {
        identityVerdict = `identity_lookup_failed: ${describeError(error)}`;
      }
    } else if (!confirmation) {
      identityVerdict = 'no_confirmation_for_run';
    }

    const live = bindings.length === 1 ? bindings[0] : null;
    const note = [
      task.fromPlanOnly ? 'plan_operation_without_journal' : null,
      task.reattempted ? 'карта встречалась в нескольких прогонах' : null,
      bindings.length > 1 ? `привязок: ${bindings.length}` : null,
    ].filter(Boolean).join('; ') || null;

    rows.push({
      runFile: path.basename(task.runFile),
      employeeId: task.employeeId,
      cardId: task.cardId,
      w26: confirmation?.w26 ?? null,
      journalOutcome: task.fromPlanOnly ? 'нет записи' : (task.outcome ?? 'prepared'),
      verdict,
      identityVerdict,
      expirationBefore: task.expirationBefore,
      expirationTarget: task.expirationTarget,
      liveExpiration: live?.expirationDate ?? null,
      liveStartDate: live?.startDate ?? null,
      liveOwner: live?.employeeId ?? null,
      syntheticStart: !!task.startDateTarget,
      reattempted: task.reattempted,
      note,
    });
    bump(verdict);
    if (task.fromPlanOnly) bump('plan_operation_without_journal');
    if (identityVerdict && identityVerdict !== 'ok') bump(`identity_${identityVerdict.split(':')[0]}`);
  };

  const concurrency = Math.max(1, Math.min(4, args.concurrency));
  let cursor = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < selected.length) {
      const index = cursor++;
      await runOne(selected[index]);
      if ((index + 1) % 100 === 0) console.log(`  ...проверено ${index + 1}/${selected.length}`);
    }
  }));

  // ── C. Покрытие ──────────────────────────────────────────────────────────────────
  interface ICoverage {
    remaining: Array<{ cardId: number; employeeId: number; name: string | null; org: string | null }>;
    skipCounts: Record<string, number>;
    alreadyExpired: number;
    driftDuplicates: number[];
  }
  let coverage: ICoverage | null = null;
  const driftRows: string[] = [];

  if (args.skipCoverage) {
    partialReasons.push('--skip-coverage: остаток и текущий drift не проверялись');
  } else {
    const confirmedIds = new Set<number>();
    for (const map of confirmationsByFile.values()) for (const cardId of map.keys()) confirmedIds.add(cardId);
    console.log(`\n[покрытие] подтверждённых карт во всех прогонах: ${confirmedIds.size}`);

    const state = await collect.collectLiveState({
      requireRootless: args.scope.includes('rootless'),
      confirmedWhiteCardIds: confirmedIds,
      deletedBlacklistPath: args.deletedBlacklist
        ? path.resolve(process.cwd(), args.deletedBlacklist)
        : undefined,
    });

    const allowSynthetic = args.coveragePolicy === 'next-batch'
      ? true
      : [...plansByFile.values()].some(plan => plan.syntheticStartDate !== null);
    const selection = util.selectBlockCandidates({
      cards: state.rows,
      allowlist: confirmedIds,
      denylist: state.denylist,
      employeesWithNewCard: state.employeesWithNewCard,
      excludedBranchCardIds: state.excludedBranchCardIds,
      options: { scope: args.scope, allowSyntheticStartDate: allowSynthetic, now: startedAt.getTime() },
    });

    const journalCardIds = new Set([...merged.records.values()].map(record => record.cardId));
    const remaining = selection.candidates
      .filter(card => !journalCardIds.has(card.cardId))
      .map(card => ({
        cardId: card.cardId,
        employeeId: card.sigurEmployeeId,
        name: card.employeeName,
        org: card.orgName,
      }));

    coverage = {
      remaining,
      skipCounts: selection.skipCounts,
      alreadyExpired: selection.skipCounts.already_expired ?? 0,
      driftDuplicates: [...state.duplicateCardIds].filter(cardId => confirmedIds.has(cardId)),
    };

    // Текущий drift: состояние ПОСЛЕ гашения, а не доказательство ошибки прошлого.
    const cardsById = new Map(state.rows.map(card => [card.cardId, card]));
    for (const record of merged.records.values()) {
      const card = cardsById.get(record.cardId);
      if (!card) { driftRows.push(`карта ${record.cardId}: сейчас отсутствует в инвентаризации`); continue; }
      if (card.scopeBucket !== 'contractors' && args.scope.includes('contractors')) {
        driftRows.push(`карта ${record.cardId} (${card.employeeName ?? '?'}): скоуп теперь "${card.scopeBucket}"`);
      }
      if (state.denylist.has(record.cardId)) {
        driftRows.push(`карта ${record.cardId} (${card.employeeName ?? '?'}): появилась связь с модулем выдачи`);
      }
      if (state.excludedBranchCardIds.has(record.cardId)) {
        driftRows.push(`карта ${record.cardId} (${card.employeeName ?? '?'}): владелец теперь в исключённой ветке`);
      }
    }
  }

  // ── D. Проходы после гашения (индикативно) ───────────────────────────────────────
  const blockedCardIds = new Set(
    rows.filter(row => (util.BLOCKED_VERDICTS as readonly string[]).includes(row.verdict)).map(row => row.cardId),
  );
  const cutoffByEmployee = new Map<number, string>();
  for (const task of selected) {
    if (!blockedCardIds.has(task.cardId)) continue;
    const cutoff = task.preparedAt ?? args.passesSince ?? startedAt.toISOString();
    const floor = args.passesSince && Date.parse(args.passesSince) > Date.parse(cutoff) ? args.passesSince : cutoff;
    const current = cutoffByEmployee.get(task.employeeId);
    if (!current || Date.parse(floor) < Date.parse(current)) cutoffByEmployee.set(task.employeeId, floor);
  }

  let passRows: Array<{ sigur_employee_id: string; passes: number; last_at: string }> = [];
  if (cutoffByEmployee.size > 0) {
    passRows = await query<{ sigur_employee_id: string; passes: number; last_at: string }>(
      `WITH cutoffs AS (
         SELECT * FROM unnest($1::bigint[], $2::timestamptz[]) AS t(sigur_employee_id, cutoff)
       )
       SELECT c.sigur_employee_id::text AS sigur_employee_id,
              count(*)::int AS passes,
              max(se.event_at)::text AS last_at
         FROM cutoffs c
         JOIN public.employees e ON e.sigur_employee_id = c.sigur_employee_id
         JOIN public.skud_events se ON se.employee_id = e.id AND se.event_at > c.cutoff
        GROUP BY 1
        ORDER BY 2 DESC`,
      [[...cutoffByEmployee.keys()], [...cutoffByEmployee.values()]],
    );
  }

  // ── Отчёт ────────────────────────────────────────────────────────────────────────
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const jsonlPath = path.join(OUT_DIR, `verify-old-card-block-${stamp}.jsonl`);
  const csvPath = path.join(OUT_DIR, `verify-old-card-block-${stamp}.csv`);

  const anomalies = rows.filter(row => util.isAnomalyVerdict(row.verdict)
    || (row.identityVerdict !== null && row.identityVerdict !== 'ok' && row.identityVerdict !== 'no_confirmation_for_run'));
  const tail = rows.filter(row => !util.isAnomalyVerdict(row.verdict)
    && ((util.TAIL_VERDICTS as readonly string[]).includes(row.verdict) || row.note?.includes('plan_operation_without_journal')));

  const meta = {
    kind: 'verify-old-card-block-report',
    startedAt: startedAt.toISOString(),
    connection,
    scope: args.scope,
    coveragePolicy: args.coveragePolicy,
    deletedBlacklist: args.deletedBlacklist
      ? {
        path: args.deletedBlacklist,
        sha256: util.sha256(fs.readFileSync(path.resolve(process.cwd(), args.deletedBlacklist), 'utf8')),
        mtime: fs.statSync(path.resolve(process.cwd(), args.deletedBlacklist)).mtime.toISOString(),
      }
      : null,
    runs: header,
    planOperationsWithoutJournal: orphanReport,
    partial: partialReasons,
  };
  const lines = [JSON.stringify(meta), ...rows.map(row => JSON.stringify(row))];
  fs.writeFileSync(jsonlPath, `${lines.join('\n')}\n`, 'utf8');

  const csvHeader = 'cardId;employeeId;w26;прогон;исход журнала;вердикт;идентичность;срок до;цель;срок сейчас;владелец сейчас;примечание';
  const csvLines = [...anomalies, ...tail].map(row => [
    row.cardId, row.employeeId, row.w26 ?? '', row.runFile, row.journalOutcome, row.verdict,
    row.identityVerdict ?? '', row.expirationBefore ?? '', row.expirationTarget,
    row.liveExpiration ?? '', row.liveOwner ?? '', row.note ?? '',
  ].join(';'));
  fs.writeFileSync(csvPath, `${[csvHeader, ...csvLines].join('\n')}\n`, 'utf8');

  console.log('\n── A. Живая перепроверка ──');
  for (const [key, count] of Object.entries(verdictCounts).sort((left, right) => right[1] - left[1])) {
    console.log(`  ${key}: ${count}`);
  }

  if (coverage) {
    console.log('\n── C. Покрытие ──');
    console.log(`  активный остаток (подтверждены, не в журналах): ${coverage.remaining.length}`);
    for (const item of coverage.remaining.slice(0, 10)) {
      console.log(`    • карта ${item.cardId} — ${item.name ?? '?'} (${item.org ?? '?'})`);
    }
    if (coverage.remaining.length > 10) console.log(`    ... ещё ${coverage.remaining.length - 10}`);
    console.log('  не подлежит гашению:');
    for (const [reason, count] of Object.entries(coverage.skipCounts)) {
      if (count > 0 && reason !== 'already_expired' && reason !== 'not_in_allowlist') {
        console.log(`    ${reason}: ${count}`);
      }
    }
    console.log(`  уже безопасно (already_expired, включая погашенные нами): ${coverage.alreadyExpired}`);
    if (coverage.driftDuplicates.length > 0) {
      console.log(`  DRIFT: подтверждённые карты стали дублями: ${coverage.driftDuplicates.join(', ')}`);
    }
  }

  if (driftRows.length > 0) {
    console.log('\n── Текущий drift (не доказательство ошибки прошлого) ──');
    for (const line of driftRows.slice(0, 20)) console.log(`  • ${line}`);
    if (driftRows.length > 20) console.log(`  ... ещё ${driftRows.length - 20}`);
  }

  console.log('\n── D. Проходы после гашения (индикативно, карта в событиях не хранится) ──');
  if (passRows.length === 0) {
    console.log('  проходов у погашенных сотрудников после отсечки нет');
  } else {
    for (const row of passRows.slice(0, 15)) {
      console.log(`  • sigur ${row.sigur_employee_id}: проходов ${row.passes}, последний ${row.last_at}`);
    }
    if (passRows.length > 15) console.log(`  ... ещё ${passRows.length - 15}`);
  }

  if (fatals.length > 0) {
    console.log('\n── Расхождения plan ↔ journal (фатальные) ──');
    for (const line of fatals.slice(0, 20)) console.log(`  • ${line}`);
    if (fatals.length > 20) console.log(`  ... ещё ${fatals.length - 20}`);
  }

  const remainingCount = coverage?.remaining.length ?? 0;
  const remainingIsTail = coverage !== null
    && remainingCount > 0
    && (args.expectRemaining === null || remainingCount !== args.expectRemaining);

  const anomalyCount = anomalies.length + fatals.length + (coverage?.driftDuplicates.length ?? 0);
  const tailCount = tail.length + (remainingIsTail ? remainingCount : 0);
  const exitCode = util.resolveExitCode({
    anomalies: anomalyCount,
    tail: tailCount,
    partial: partialReasons.length > 0,
  });

  console.log(`\nОтчёт: ${jsonlPath}`);
  console.log(`Аномалии и хвост: ${csvPath}`);
  if (partialReasons.length > 0) {
    console.log('\nPARTIAL — это НЕ итог аудита:');
    for (const reason of partialReasons) console.log(`  • ${reason}`);
  }
  console.log(`\nИтог: аномалий ${anomalyCount}, хвоста ${tailCount} → код ${exitCode}`);
  process.exit(exitCode);
}

main().catch((error: unknown) => {
  const err = error as Error;
  console.error('\nОшибка аудита:', err?.stack ?? err?.message ?? error);
  process.exit(1);
});
