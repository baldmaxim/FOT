/**
 * Сверка и откат запуска записи физлиц 1С по журналу и истории «Реквизитов».
 *
 * Сверка: у каждого записанного человека каждое поле = значению 1С (с точностью до формата,
 * шифрованные — строгой расшифровкой), код 1С = id_all; события истории запуска совпадают с
 * журналом (created, profile_update по полям, событие кода 1С); событий у людей вне журнала нет.
 * Откат: поле очищается, только если оно всё ещё равно значению 1С и после запуска его никто
 * не менял; иначе — отказ по полю. Профиль, созданный запуском, удаляется, если опустел и
 * чужих событий в его истории нет.
 */
import { query, withTransaction } from '../../config/postgres.js';
import { applyProfilePatch, findCitizenshipByValue, recordHistory, type IHrActor, type IHrProfileInput } from '../hr-profile.service.js';
import type { IDb } from './facts.js';
import { FILL_FIELDS, loadCurrentState, sameValue, values1c, type FillField } from './fill.js';
import { loadSource, poolDb, readJournal, rollbackActorName, type IJournalItem } from './run.js';
import type { IPerson1c } from './parse.js';

interface IRunEvent { employee_id: number; id: number; event_type: string; changed_fields: string[] | null }

const runEvents = async (actorName: string): Promise<Map<number, IRunEvent[]>> => {
  const rows = await query<IRunEvent>(
    `SELECT employee_id, id, event_type, changed_fields FROM employee_hr_profile_history
      WHERE changed_by_name = $1 AND changed_source = 'import' ORDER BY id`, [actorName]);
  const out = new Map<number, IRunEvent[]>();
  for (const r of rows) out.set(Number(r.employee_id), [...(out.get(Number(r.employee_id)) ?? []), { ...r, id: Number(r.id) }]);
  return out;
};

const updatedFields = (events: IRunEvent[]): Set<string> =>
  new Set(events.filter(e => e.event_type === 'profile_update').flatMap(e => e.changed_fields ?? []));

const loadContext = async (file: string, journal: string) => {
  const { run, items } = readJournal(journal);
  const src = await loadSource(file, run.as_of);
  if (src.sha256 !== run.source_sha256) throw new Error('Файл 1С не тот, что при записи (SHA-256 не совпал)');
  const persons = new Map(src.persons.map(p => [p.idAll, p]));
  const byEmployee = new Map<number, IJournalItem>();
  for (const it of items) if (it.employee_id !== null && (it.status === 'applied' || it.status === 'unchanged')) byEmployee.set(it.employee_id, it);
  return { run, items, persons, byEmployee };
};

export interface IAuditResult {
  counts: Map<string, number>;
  problems: string[];
}

const inc = (m: Map<string, number>, k: string, by = 1): void => { m.set(k, (m.get(k) ?? 0) + by); };

const expectedValue = async (person: IPerson1c, field: FillField): Promise<string | null> =>
  values1c(person, await findCitizenshipByValue(person.citizenship))[field];

export const runVerify = async (opts: { file: string; journal: string }): Promise<IAuditResult> => {
  const { run, items, persons, byEmployee } = await loadContext(opts.file, opts.journal);
  const events = await runEvents(run.actor_name);
  const counts = new Map<string, number>();
  const problems: string[] = [];
  const applied = items.filter(i => i.status === 'applied');
  for (const it of applied) {
    const id = it.employee_id!;
    const ev = events.get(id) ?? [];
    const person = persons.get(it.id_all);
    if (!person) { problems.push(`#${id}: физлица нет в файле`); continue; }
    const created = ev.filter(e => e.event_type === 'created').length;
    if (created !== (it.profile_created ? 1 : 0)) problems.push(`#${id}: событий «created» ${created}, в журнале ${it.profile_created ? 1 : 0}`);
    const fieldsDb = updatedFields(ev);
    const idAllEvent = fieldsDb.delete('passdesk_id_all');
    if (idAllEvent !== it.id_all_set) problems.push(`#${id}: событие кода 1С ${idAllEvent ? 'есть' : 'нет'}, в журнале ${it.id_all_set ? 'есть' : 'нет'}`);
    const fieldsJournal = new Set(it.filled);
    if (fieldsDb.size !== fieldsJournal.size || [...fieldsJournal].some(f => !fieldsDb.has(f))) problems.push(`#${id}: поля в истории ≠ журналу`);
    const state = await loadCurrentState(poolDb, id, { lock: false });
    for (const f of it.filled as FillField[]) {
      const want = await expectedValue(person, f);
      const have = state.values[f];
      if (!want || !have || !sameValue(f, want, have)) problems.push(`#${id}: поле «${f}» не равно значению 1С`);
      else inc(counts, 'полей сверено');
    }
    if (state.passdeskIdAll !== it.id_all) problems.push(`#${id}: код 1С в профиле не тот`);
    inc(counts, 'людей сверено');
    if (it.profile_created) inc(counts, 'профилей создано');
    if (it.id_all_set) inc(counts, 'кодов 1С проставлено');
  }
  for (const id of events.keys()) {
    if (!byEmployee.has(id) || byEmployee.get(id)!.status !== 'applied') problems.push(`#${id}: есть события запуска, а в журнале записи нет`);
  }
  for (const it of items) inc(counts, `статус ${it.status}`);
  return { counts, problems };
};

/** Данные в профиле, кроме служебных столбцов: после отката пусто — профиль можно удалить. */
const PROFILE_DATA_COLUMNS = [
  'citizenship_id', 'gender', 'birth_country_id', 'birth_region', 'birth_city', 'phone', 'passport_type', 'passport_number_enc',
  'passport_date', 'passport_issuer', 'passport_department_code', 'passport_expiry_date', 'registration_address', 'inn_enc',
  'kig_enc', 'kig_end_date', 'patent_number_enc', 'patent_blank_number', 'insurance_policy_number', 'insurance_policy_date',
  'bank_account_number_enc', 'bank_bik', 'planned_exit_date', 'notes', 'passdesk_id_all', 'passdesk_id',
];

export const runRollback = async (opts: { file: string; journal: string; userId: string }): Promise<IAuditResult> => {
  const { run, persons, byEmployee } = await loadContext(opts.file, opts.journal);
  const events = await runEvents(run.actor_name);
  const rollbackName = rollbackActorName(run.run_id);
  const actor: IHrActor = { userId: opts.userId, userName: rollbackName };
  const counts = new Map<string, number>();
  const problems: string[] = [];

  for (const [employeeId, ev] of events) {
    const it = byEmployee.get(employeeId);
    const person = it ? persons.get(it.id_all) : undefined;
    if (!it || !person) { problems.push(`#${employeeId}: нет записи в журнале — не откатывается`); continue; }
    const firstId = Math.min(...ev.map(e => e.id));
    try {
      await withTransaction(async client => {
        const db: IDb = { query: (sql, params) => client.query(sql, params as unknown[]) as never };
        const state = await loadCurrentState(db, employeeId, { lock: true });
        const later = (await client.query<{ changed_fields: string[] | null; event_type: string }>(
          `SELECT changed_fields, event_type FROM employee_hr_profile_history
            WHERE employee_id = $1 AND id > $2 AND changed_by_name IS DISTINCT FROM $3 AND changed_by_name IS DISTINCT FROM $4`,
          [employeeId, firstId, run.actor_name, rollbackName])).rows;
        const touched = new Set(later.flatMap(l => l.changed_fields ?? []));
        const fields = updatedFields(ev);
        const idAllWasSet = fields.delete('passdesk_id_all');
        const input: IHrProfileInput = {};
        for (const f of fields) {
          if (!(FILL_FIELDS as readonly string[]).includes(f)) { problems.push(`#${employeeId}: неизвестное поле «${f}»`); continue; }
          const want = await expectedValue(person, f as FillField);
          const have = state.values[f as FillField];
          if (touched.has(f) || !want || !have || !sameValue(f as FillField, want, have)) {
            problems.push(`#${employeeId}: поле «${f}» после записи менялось — оставлено`);
            continue;
          }
          (input as Record<string, null>)[f] = null;
        }
        if (Object.keys(input).length > 0) {
          const res = await applyProfilePatch(client, employeeId, input, actor, 'import');
          if (res.zupReset) await client.query(`UPDATE employee_hr_profiles SET zup_is_uploaded = true WHERE employee_id = $1`, [employeeId]);
          if ('citizenship_id' in input && it.country_before) {
            await client.query(`UPDATE employees SET country = $2, updated_at = now() WHERE id = $1`, [employeeId, it.country_before]);
          }
          inc(counts, 'полей очищено', Object.keys(input).length);
        }
        if (idAllWasSet && !touched.has('passdesk_id_all')) {
          const res = await client.query(
            `UPDATE employee_hr_profiles SET passdesk_id_all = NULL, updated_at = now() WHERE employee_id = $1 AND passdesk_id_all = $2::uuid`,
            [employeeId, it.id_all]);
          if (res.rowCount === 1) {
            await recordHistory(client, employeeId, 'profile_update', { changedFields: ['passdesk_id_all'], actor, source: 'import' });
            inc(counts, 'кодов 1С снято');
          }
        }
        if (ev.some(e => e.event_type === 'created') && later.length === 0) {
          const empty = (await client.query<{ empty: boolean }>(
            `SELECT (${PROFILE_DATA_COLUMNS.map(c => `${c} IS NULL`).join(' AND ')}) AS empty FROM employee_hr_profiles WHERE employee_id = $1`,
            [employeeId])).rows[0]?.empty === true;
          if (empty) {
            await client.query(`DELETE FROM employee_hr_profiles WHERE employee_id = $1`, [employeeId]);
            inc(counts, 'профилей удалено');
          }
        }
      });
      inc(counts, 'людей обработано');
    } catch (err) {
      problems.push(`#${employeeId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { counts, problems };
};
