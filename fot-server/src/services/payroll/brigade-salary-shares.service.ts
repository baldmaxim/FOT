/**
 * Проверка «Доли», вписанной рублями (миграция 355), — чистая функция над вводом бригады, прочитанным под замком
 * записи, и учтёнными минутами текущего расчёта. Объект с новой долей считается той же функцией, что расчёт
 * (shareConflicts): что прошло проверку, то и посчитается.
 *
 * Пропускается: объект с новой долей сходится; или конфликты были и раньше, новых нет, а доля уменьшается (исправление
 * по шагам). Иначе — BrigadeShareRejectedError с текстом: максимум при КТУ 2,2 (сам или уже вписанный), «можно только
 * ровно остаток», «сначала сотрите долю без часов».
 */
import {
  centsToMoney,
  maxFixedShare,
  moneyToCents,
  shareConflicts,
  type IBrigadeShareConflict,
} from './brigade-salary.calc.js';
import {
  BRIGADE_WHOLE_SHARE_KEY,
  BrigadeShareRejectedError,
  DEFAULT_KTU_TENTHS,
  fixedSharesInCents,
  type IBrigadeSalaryInputs,
} from './brigade-salary-inputs.service.js';

/** Учтённые минуты участника на ключе выработки (у суммы бригаде — за месяц). */
export interface IShareMinutes {
  employee_id: number;
  minutes: number;
}

/** «196 428,57» — копейки в рубли с разрядами. */
export const formatRubles = (cents: bigint): string => {
  const [whole, fraction] = centsToMoney(cents).split('.');
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')},${fraction}`;
};

/** «Амонов А. М.» из полного ФИО; пусто — «№ id». */
export const shortEmployeeName = (fullName: string | undefined, employeeId: number): string => {
  const parts = (fullName ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return `№ ${employeeId}`;
  return [parts[0], ...parts.slice(1, 3).map(part => `${part[0]}.`)].join(' ');
};

const sameConflict = (a: IBrigadeShareConflict, b: IBrigadeShareConflict): boolean => (
  a.code === b.code && (a.employee_id ?? null) === (b.employee_id ?? null)
);

const ktuText = (ktu: string | null | undefined): string => (ktu ? ktu.replace('.', ',') : 'бесконечный');

/** Текст конфликта, который мешает вписать долю. */
const conflictText = (conflict: IBrigadeShareConflict, nameOf: (id: number) => string): string => {
  switch (conflict.code) {
    case 'fixed_without_hours':
      return `Сначала сотрите вписанную долю (${nameOf(conflict.employee_id!)}): нет учтённых часов на объекте`;
    case 'fixed_exceeds_output':
      return `Вписанные доли больше выработки на ${formatRubles(moneyToCents(conflict.amount ?? '0'))} — сначала уменьшите их`;
    case 'remainder_without_weight':
      return `Остаток ${formatRubles(moneyToCents(conflict.amount ?? '0'))} некому распределить`;
    case 'ktu_above_max':
      return `Сначала уменьшите вписанную долю (${nameOf(conflict.employee_id!)}): КТУ по ней ${ktuText(conflict.ktu)} — больше 2,2`;
  }
};

/**
 * Можно ли вписать сотруднику долю amountCents на ключе (object_key или '__brigade__'). inputs — прочитаны в транзакции
 * записи под замком бригады; minutes — учтённые минуты участников ключа из текущего расчёта; names — ФИО для текста.
 * Ничего не возвращает; отказ — BrigadeShareRejectedError.
 */
export const checkFixedShare = (
  inputs: IBrigadeSalaryInputs,
  key: string,
  minutes: readonly IShareMinutes[],
  employeeId: number,
  amountCents: bigint,
  names: ReadonlyMap<number, string>,
): void => {
  const nameOf = (id: number): string => shortEmployeeName(names.get(id), id);
  const brigadeKey = key === BRIGADE_WHOLE_SHARE_KEY;
  if (brigadeKey && inputs.brigadeOutput === null) {
    throw new BrigadeShareRejectedError(
      inputs.outputs.size > 0
        ? 'Выработка внесена по объектам — долю вписывают в строке объекта'
        : 'Сначала внесите выработку бригады',
    );
  }
  if (!brigadeKey && inputs.brigadeOutput !== null) {
    throw new BrigadeShareRejectedError('Выработка внесена бригаде — долю вписывают в «Итого по бригаде»');
  }
  const output = brigadeKey ? inputs.brigadeOutput : inputs.outputs.get(key)?.amount ?? null;
  if (output === null) throw new BrigadeShareRejectedError('Сначала внесите выработку объекта');
  const outputCents = moneyToCents(output);

  const items = minutes
    .filter(item => item.minutes > 0)
    .map(item => ({
      employee_id: item.employee_id,
      minutes: item.minutes,
      weight: BigInt(inputs.ktu.get(item.employee_id) ?? DEFAULT_KTU_TENTHS) * BigInt(item.minutes),
    }));
  if (!items.some(item => item.employee_id === employeeId)) {
    throw new BrigadeShareRejectedError(
      brigadeKey ? 'У сотрудника нет учтённых часов за месяц' : 'У сотрудника нет учтённых часов на этом объекте',
    );
  }

  const fixedNow = fixedSharesInCents(inputs, key);
  const fixedNext = new Map(fixedNow).set(employeeId, amountCents);
  const before = shareConflicts(outputCents, items, fixedNow);
  const after = shareConflicts(outputCents, items, fixedNext);
  if (after.length === 0) return;
  const introduced = after.filter(conflict => !before.some(previous => sameConflict(previous, conflict)));
  const previous = fixedNow.get(employeeId);
  if (introduced.length === 0 && previous !== undefined && amountCents < previous) return;

  // Чужая доля без часов — её сначала стереть: максимум тут ничего не скажет.
  const orphan = after.find(conflict => conflict.code === 'fixed_without_hours' && conflict.employee_id !== employeeId);
  if (orphan) throw new BrigadeShareRejectedError(conflictText(orphan, nameOf));

  const others = new Map(fixedNow);
  others.delete(employeeId);
  const max = maxFixedShare(outputCents, items, others, employeeId);
  if (!max) throw new BrigadeShareRejectedError(conflictText(after[0], nameOf));
  if (max.exact) {
    throw new BrigadeShareRejectedError(
      `Остаток выработки некому распределить: у остальных доли вписаны или КТУ 0 — можно вписать только ${formatRubles(max.max)}`,
    );
  }
  if (max.limitedBy === employeeId) {
    throw new BrigadeShareRejectedError(`${nameOf(employeeId)}: максимум — ${formatRubles(max.max)} (КТУ 2,2)`);
  }
  throw new BrigadeShareRejectedError(
    `Максимум — ${formatRubles(max.max)}: иначе КТУ по вписанной доле (${nameOf(max.limitedBy)}) станет больше 2,2`,
  );
};
