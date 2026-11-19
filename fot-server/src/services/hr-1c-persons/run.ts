/**
 * Предпросмотр и запись физлиц 1С. Журнал записи — JSONL (права 600): шапка запуска,
 * строка на человека после COMMIT, итог. Значений ПДн в журнале и в консоли нет.
 * Атомарный след каждой записи — история «Реквизитов» с именем актора «… · run <id>».
 */
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { query, withTransaction } from '../../config/postgres.js';
import { readExcelRows } from '../../utils/excel-reader.js';
import { findCitizenshipByValue, type IHrActor } from '../hr-profile.service.js';
import { applyPersonInTransaction } from './apply.js';
import { loadPersonFacts, personKeys, type IDb } from './facts.js';
import { HrIntegrityError, loadCurrentState, planFill } from './fill.js';
import { decidePerson, resolveSharedCards, type IDecision, type IPersonKeys } from './match.js';
import { collapsePersons, parsePersons1cRows, sha256OfBuffer, type IPerson1c } from './parse.js';
import { buildRemarks, readReport, writeReport, type IReportItem } from './report.js';

export const poolDb: IDb = { query: async (sql, params) => ({ rows: await query(sql, params) }) as never };

export const runActorName = (runId: string): string => `Загрузка физлиц 1С · run ${runId}`;
export const rollbackActorName = (runId: string): string => `Откат загрузки физлиц 1С · run ${runId}`;

export interface ISource {
  sha256: string;
  persons: IPerson1c[];
  dismissed: number;
  rows: number;
}

export const loadSource = async (file: string, asOf: string): Promise<ISource> => {
  const buf = fs.readFileSync(file);
  const { rows } = parsePersons1cRows(await readExcelRows(buf));
  const { working, dismissed } = collapsePersons(rows, asOf);
  return { sha256: sha256OfBuffer(buf), persons: working, dismissed, rows: rows.length };
};

interface IDecided {
  idAll: string;
  person: IPerson1c;
  keys: IPersonKeys;
  decision: IDecision;
  cards: Map<number, { id: number; fullName: string; department: string | null; hasProfile: boolean }>;
}

const decideAll = async (persons: IPerson1c[], asOf: string, manual: Map<string, number | null>): Promise<IDecided[]> => {
  const out: IDecided[] = [];
  for (const person of persons) {
    const keys = personKeys(person);
    const manualId = manual.get(person.idAll) ?? null;
    const facts = await loadPersonFacts(poolDb, person, keys, asOf, manualId ? [manualId] : []);
    out.push({ idAll: person.idAll, person, keys, decision: decidePerson(keys, facts, manualId), cards: facts.cards });
  }
  resolveSharedCards(out);
  return out;
};

const inc = (m: Map<string, number>, k: string, by = 1): void => { m.set(k, (m.get(k) ?? 0) + by); };

export const runPreview = async (opts: { file: string; asOf: string; out: string }): Promise<Map<string, number>> => {
  const src = await loadSource(opts.file, opts.asOf);
  const decided = await decideAll(src.persons, opts.asOf, new Map());
  const items: IReportItem[] = [];
  const stats = new Map<string, number>([['Строк в файле', src.rows], ['Физлиц уволено на дату среза (не трогаем)', src.dismissed], ['Работают на дату среза', src.persons.length]]);
  for (const d of decided) {
    let { decision } = d;
    let plan = null;
    let needIdAll = false;
    if (decision.kind === 'apply') {
      try {
        const state = await loadCurrentState(poolDb, decision.employeeId!, { lock: false });
        plan = planFill(d.person, state, await findCitizenshipByValue(d.person.citizenship));
        needIdAll = state.passdeskIdAll === null;
      } catch (err) {
        if (!(err instanceof HrIntegrityError)) throw err;
        decision = { ...decision, kind: 'manual', employeeId: null, reasons: [err.message] };
      }
    }
    const card = decision.employeeId !== null ? d.cards.get(decision.employeeId) ?? null : null;
    items.push({ person: d.person, decision, card, plan, needIdAll, remarks: buildRemarks(d.person, decision, plan) });
    if (decision.kind === 'apply') {
      inc(stats, `Заносим: ${decision.tier === 'id_all' ? 'по коду 1С' : decision.tier === 'strong' ? 'по СНИЛС/ИНН/паспорту/ФИО+ДР' : 'по ФИО и отделу'}`);
      if (card && !card.hasProfile) inc(stats, 'Профиль «Реквизиты» будет создан');
      if (needIdAll) inc(stats, 'Будет проставлен код 1С');
      if (plan && plan.fields.length > 0) inc(stats, 'Людей, у кого заполняются поля');
      if (plan && plan.diffs.length > 0) inc(stats, 'Людей с расхождениями (FOT не меняется)');
      if (plan && plan.fields.length === 0 && !needIdAll) inc(stats, 'Нечего заполнять (всё уже есть)');
    } else {
      inc(stats, 'Проверить вручную');
    }
  }
  await writeReport(opts.out, items, { sourceSha256: src.sha256, asOf: opts.asOf, previewRun: new Date().toISOString() }, [...stats]);
  return stats;
};

export interface IJournalItem {
  type: 'item';
  id_all: string;
  employee_id: number | null;
  status: 'applied' | 'unchanged' | 'skipped_changed' | 'error' | 'manual_pending';
  tier: string | null;
  filled: string[];
  profile_created: boolean;
  id_all_set: boolean;
  zup_restored: boolean;
  country_before: string | null;
  reason: string | null;
}

export interface IJournalRun {
  type: 'run';
  run_id: string;
  source_sha256: string;
  as_of: string;
  started_at: string;
  user_id: string;
  actor_name: string;
}

const appendLine = (file: string, obj: unknown): void => {
  fs.appendFileSync(file, `${JSON.stringify(obj)}\n`, { mode: 0o600 });
};

export const readJournal = (file: string): { run: IJournalRun; items: IJournalItem[] } => {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as { type: string });
  const run = lines.find(l => l.type === 'run') as IJournalRun | undefined;
  if (!run) throw new Error('В журнале нет шапки запуска');
  return { run, items: lines.filter(l => l.type === 'item') as IJournalItem[] };
};

export const runApply = async (opts: { file: string; asOf: string; report: string; journal: string; userId: string }): Promise<Map<string, number>> => {
  const src = await loadSource(opts.file, opts.asOf);
  const decisions = await readReport(opts.report, { sourceSha256: src.sha256, asOf: opts.asOf });
  const known = new Set(src.persons.map(p => p.idAll));
  const missing = src.persons.filter(p => !decisions.has(p.idAll)).length;
  const extra = [...decisions.keys()].filter(id => !known.has(id)).length;
  if (missing > 0 || extra > 0) throw new Error(`Отчёт не совпадает с файлом: нет ${missing}, лишних ${extra}`);
  const user = await query<{ id: string }>(`SELECT id FROM user_profiles WHERE id = $1::uuid`, [opts.userId]);
  if (user.length !== 1) throw new Error('HR_IMPORT_USER_ID не найден в user_profiles');
  if (fs.existsSync(opts.journal)) throw new Error(`Журнал ${opts.journal} уже есть — укажите новый файл`);

  const runId = randomBytes(4).toString('hex');
  const actorName = runActorName(runId);
  const actor: IHrActor = { userId: opts.userId, userName: actorName };
  appendLine(opts.journal, {
    type: 'run', run_id: runId, source_sha256: src.sha256, as_of: opts.asOf, started_at: new Date().toISOString(),
    user_id: opts.userId, actor_name: actorName,
  } satisfies IJournalRun);

  const manual = new Map([...decisions].map(([id, d]) => [id, d.manualEmployeeId]));
  const decided = await decideAll(src.persons, opts.asOf, manual);
  const stats = new Map<string, number>();
  for (const d of decided) {
    const r = decisions.get(d.idAll)!;
    const target = r.manualEmployeeId ?? (r.previewKind === 'apply' ? r.previewEmployeeId : null);
    const item: IJournalItem = {
      type: 'item', id_all: d.idAll, employee_id: target, status: 'manual_pending', tier: null, filled: [],
      profile_created: false, id_all_set: false, zup_restored: false, country_before: null, reason: null,
    };
    if (target === null) {
      inc(stats, item.status);
      appendLine(opts.journal, item);
      continue;
    }
    inc(stats, 'planned');
    if (d.decision.kind !== 'apply' || d.decision.employeeId !== target) {
      item.status = 'skipped_changed';
      item.reason = d.decision.kind === 'apply' ? `теперь сопоставляется с #${d.decision.employeeId}` : d.decision.reasons.join('; ');
    } else {
      try {
        const citizenship = await findCitizenshipByValue(d.person.citizenship);
        const res = await withTransaction(client => applyPersonInTransaction(client, {
          person: d.person, keys: d.keys, expectedEmployeeId: target, manualEmployeeId: r.manualEmployeeId,
          citizenship, asOf: opts.asOf, actor,
        }));
        Object.assign(item, {
          status: res.status, tier: res.tier, filled: res.filled, profile_created: res.profileCreated, id_all_set: res.idAllSet,
          zup_restored: res.zupRestored, country_before: res.countryBefore, reason: res.reasons.join('; ') || null,
        });
      } catch (err) {
        item.status = 'error';
        item.reason = `${err instanceof Error ? err.name : 'Error'}: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    inc(stats, item.status);
    appendLine(opts.journal, item);
  }
  const planned = stats.get('planned') ?? 0;
  const accounted = ['applied', 'unchanged', 'skipped_changed', 'error'].reduce((s, k) => s + (stats.get(k) ?? 0), 0);
  appendLine(opts.journal, { type: 'summary', run_id: runId, finished_at: new Date().toISOString(), stats: Object.fromEntries(stats) });
  if (planned !== accounted) throw new Error(`Итог не сходится: запланировано ${planned}, учтено ${accounted}`);
  stats.set(`run ${runId}`, 0);
  return stats;
};
