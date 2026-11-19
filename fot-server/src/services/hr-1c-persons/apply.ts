/**
 * Запись одного физлица 1С в карточку — внутри транзакции вызывающего:
 * FOR UPDATE карточки и профиля → сопоставление заново по свежим данным → строгое чтение
 * текущих значений → только пустые поля через штатный applyProfilePatch (шифрование, хэши,
 * hr_identity_claims, чёрный список, история с источником 'import') → код 1С условным UPDATE.
 * Флаг «ЗУП» не сбивается: данные пришли из самой 1С.
 */
import type { PoolClient } from 'pg';
import { applyProfilePatch, createProfile, recordHistory, type IHrActor, type IHrCitizenship } from '../hr-profile.service.js';
import { loadPersonFacts, type IDb } from './facts.js';
import { loadCurrentState, planFill, type FillField, type IDiff } from './fill.js';
import { decidePerson, type IPersonKeys, type Tier } from './match.js';
import type { IPerson1c } from './parse.js';

export interface IApplyInput {
  person: IPerson1c;
  keys: IPersonKeys;
  /** Карточка, выбранная предпросмотром (или вручную). */
  expectedEmployeeId: number;
  manualEmployeeId: number | null;
  citizenship: IHrCitizenship | null;
  asOf: string;
  actor: IHrActor;
}

export type ApplyStatus = 'applied' | 'unchanged' | 'skipped_changed';

export interface IApplyResult {
  status: ApplyStatus;
  employeeId: number;
  tier: Tier | null;
  /** Поля, реально изменённые applyProfilePatch. */
  filled: string[];
  profileCreated: boolean;
  idAllSet: boolean;
  zupRestored: boolean;
  /** employees.country до записи — для отката гражданства. */
  countryBefore: string | null;
  diffs: IDiff[];
  reasons: string[];
}

export const applyPersonInTransaction = async (client: PoolClient, input: IApplyInput): Promise<IApplyResult> => {
  const { person, keys, expectedEmployeeId: employeeId, actor } = input;
  const base = { employeeId, filled: [], profileCreated: false, idAllSet: false, zupRestored: false, diffs: [] as IDiff[] };

  // 1. Блокировка до любых решений: пользователь не изменит карточку между проверкой и записью.
  const db: IDb = { query: (sql, params) => client.query(sql, params as unknown[]) as never };
  const state = await loadCurrentState(db, employeeId, { lock: true });

  // 2. Сопоставление заново — под блокировкой и по тем же правилам, что в предпросмотре.
  const facts = await loadPersonFacts(db, person, keys, input.asOf, [employeeId]);
  const decision = decidePerson(keys, facts, input.manualEmployeeId);
  if (decision.kind !== 'apply' || decision.employeeId !== employeeId) {
    const reasons = decision.kind === 'apply' ? [`теперь сопоставляется с #${decision.employeeId}`] : decision.reasons;
    return { ...base, status: 'skipped_changed', tier: decision.tier, countryBefore: state.country, reasons };
  }

  // 3. План по свежим значениям (ошибка расшифровки уже выброшена из loadCurrentState).
  const plan = planFill(person, state, input.citizenship);
  const needIdAll = state.passdeskIdAll === null;
  if (state.passdeskIdAll !== null && state.passdeskIdAll !== person.idAll) {
    throw new Error('У профиля другой код 1С');
  }
  if (plan.fields.length === 0 && !needIdAll) {
    return { ...base, status: 'unchanged', tier: decision.tier, countryBefore: state.country, diffs: plan.diffs, reasons: [] };
  }

  // 4. Запись. Новый профиль — createProfile (событие «created»), иначе — патч.
  let filled: string[] = [];
  let zupReset = false;
  let profileCreated = false;
  if (!state.hasProfile) {
    const res = await createProfile(employeeId, plan.input, actor, 'import', { client, matchRule: `1c:${decision.tier}` });
    // Профиль успел завести человек (план считался по пустому) — откат, разберёт повтор.
    if (!res.created) throw new Error('Профиль создан параллельно — человек пропущен, повторите запуск');
    filled = res.changedFields;
    zupReset = res.zupReset;
    profileCreated = res.created;
  } else if (plan.fields.length > 0) {
    const res = await applyProfilePatch(client, employeeId, plan.input, actor, 'import');
    filled = res.changedFields;
    zupReset = res.zupReset;
  }
  const unexpected = filled.filter(f => !plan.fields.includes(f as FillField));
  if (unexpected.length > 0) throw new Error(`Изменились поля вне плана: ${unexpected.join(', ')}`);
  if (zupReset) await client.query(`UPDATE employee_hr_profiles SET zup_is_uploaded = true WHERE employee_id = $1`, [employeeId]);

  // 5. Код 1С — только в пустое; гонку ловит условие UPDATE.
  let idAllSet = false;
  if (needIdAll) {
    const res = await client.query(
      `UPDATE employee_hr_profiles SET passdesk_id_all = $2::uuid, updated_at = now()
        WHERE employee_id = $1 AND passdesk_id_all IS NULL`, [employeeId, person.idAll]);
    if (res.rowCount !== 1) throw new Error('Код 1С у профиля уже заполнен');
    await recordHistory(client, employeeId, 'profile_update', { changedFields: ['passdesk_id_all'], actor, source: 'import' });
    idAllSet = true;
  }
  return {
    status: 'applied', employeeId, tier: decision.tier, filled, profileCreated, idAllSet, zupRestored: zupReset,
    countryBefore: state.country, diffs: plan.diffs, reasons: [],
  };
};
