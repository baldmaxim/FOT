/**
 * Обучение по ОТ своих сотрудников (панель под строкой на вкладке «Управление кадрами →
 * Вводный инструктаж»). Даты живут в employee_ot_trainings (миграция 234), по строке на вид;
 * снятие даты = DELETE строки.
 *
 * Два обязательства перед переходным периодом:
 *   1. dual-write: вводный инструктаж и программа А пишутся ещё и в employee_inductions —
 *      на ней держатся фильтр «Без инструктажа / Пройден», счётчик «Пройдено N из M» и
 *      безопасный откат бэкенда;
 *   2. обратное направление закрывает триггер из 234: правки старого PATCH доезжают сюда.
 */
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../config/postgres.js';
import {
  computeOtStatus,
  otTrainingDef,
  otTrainingsFor,
  type IEmployeeOtTrainingState,
  type OtTrainingKind,
} from './ot-training.service.js';

/** Максимальная длина текстового уточнения (профессии). Дублируется в zod-схеме контроллера. */
export const OT_NOTE_MAX_LENGTH = 120;

/** Ошибка бизнес-правила: контроллер отвечает 400 с этим текстом. */
export class EmployeeOtTrainingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmployeeOtTrainingError';
  }
}

interface ITrainingRow {
  kind: string;
  passed_on: string;
  note: string | null;
}

/** Строка сотрудника в скоупе вкладки. Условия совпадают со списком и с setInduction. */
const EMPLOYEE_IN_SCOPE_SQL = `
  SELECT e.id
    FROM employees e
   WHERE e.id = $1
     AND e.org_department_id = ANY($2::uuid[])
     AND e.is_archived = false
     AND e.employment_status <> 'fired'`;

/**
 * Состояния всех видов обучения сотрудника (включая непройденные — status 'missing').
 * null — сотрудник вне скоупа / уволен / архивный: 404 без раскрытия причины.
 */
export const listEmployeeTrainings = async (
  employeeId: number,
  scopeIds: string[],
  todayIso: string,
): Promise<IEmployeeOtTrainingState[] | null> => {
  if (scopeIds.length === 0) return null;

  const found = await query<{ id: number }>(EMPLOYEE_IN_SCOPE_SQL, [employeeId, scopeIds]);
  if (found.length === 0) return null;

  const rows = await query<ITrainingRow>(
    `SELECT kind, to_char(passed_on, 'YYYY-MM-DD') AS passed_on, note
       FROM employee_ot_trainings
      WHERE employee_id = $1`,
    [employeeId],
  );
  const byKind = new Map(rows.map(r => [r.kind, r]));

  return otTrainingsFor('employee').map(def => {
    const row = byKind.get(def.kind);
    return {
      ...computeOtStatus(def, row?.passed_on ?? null, todayIso),
      note: row?.note ?? null,
    };
  });
};

export interface ISetEmployeeTrainingInput {
  employeeId: number;
  kind: OtTrainingKind;
  /** undefined — не менять дату, null — снять (DELETE строки вместе с профессией). */
  passedOn?: string | null;
  /** undefined — не менять профессию, null — очистить. */
  note?: string | null;
  userId: string;
  scopeIds: string[];
}

export interface IOtFieldDiff {
  passed_on?: { from: string | null; to: string | null };
  note?: { from: string | null; to: string | null };
}

export type SetEmployeeTrainingResult =
  | { found: false }
  | { found: true; changed: boolean; diff: IOtFieldDiff };

/** Пустая строка профессии — это отсутствие профессии, а не значение ''. */
const normalizeNote = (note: string | null | undefined): string | null | undefined => {
  if (note === undefined) return undefined;
  if (note === null) return null;
  const trimmed = note.trim();
  return trimmed === '' ? null : trimmed;
};

/**
 * Установка/снятие даты и профессии по одному виду обучения.
 *
 * Патч частичный: не переданное поле сохраняется как есть — иначе сохранение профессии
 * по уходу фокуса стирало бы дату. Сотрудник блокируется FOR UPDATE, поэтому два
 * одновременных PATCH не запишут в аудит неверный previous.
 */
export const setEmployeeTraining = async (
  input: ISetEmployeeTrainingInput,
): Promise<SetEmployeeTrainingResult> => {
  const { employeeId, kind, userId, scopeIds } = input;
  if (scopeIds.length === 0) return { found: false };

  // Вид вне каталога до FK не доводим — иначе 500 вместо внятного 400.
  const def = otTrainingDef(kind);
  if (!def) throw new EmployeeOtTrainingError('Неизвестный вид обучения');

  const note = normalizeNote(input.note);
  if (note !== undefined && !def.hasNote) {
    throw new EmployeeOtTrainingError(`Для вида «${def.label}» профессия не указывается`);
  }
  if (note !== null && note !== undefined && note.length > OT_NOTE_MAX_LENGTH) {
    throw new EmployeeOtTrainingError('Слишком длинное значение профессии');
  }

  return withTransaction(async (client: PoolClient) => {
    const target = await client.query<{ id: number }>(
      `${EMPLOYEE_IN_SCOPE_SQL} FOR UPDATE`,
      [employeeId, scopeIds],
    );
    if (target.rows.length === 0) return { found: false };

    const prev = await client.query<ITrainingRow>(
      `SELECT kind, to_char(passed_on, 'YYYY-MM-DD') AS passed_on, note
         FROM employee_ot_trainings
        WHERE employee_id = $1 AND kind = $2
        FOR UPDATE`,
      [employeeId, kind],
    );
    const before = prev.rows[0] ?? null;
    const prevDate = before?.passed_on ?? null;
    const prevNote = before?.note ?? null;

    const nextDate = input.passedOn !== undefined ? input.passedOn : prevDate;
    // Снятие даты уносит и профессию: профессия без прохождения повисла бы сиротой.
    const nextNote = nextDate === null ? null : (note !== undefined ? note : prevNote);

    if (nextDate === null && prevDate === null && note !== undefined && note !== null) {
      throw new EmployeeOtTrainingError('Сначала укажите дату прохождения');
    }

    const diff: IOtFieldDiff = {};
    if (prevDate !== nextDate) diff.passed_on = { from: prevDate, to: nextDate };
    if (prevNote !== nextNote) diff.note = { from: prevNote, to: nextNote };
    if (Object.keys(diff).length === 0) {
      return { found: true, changed: false, diff };
    }

    if (nextDate === null) {
      await client.query(
        'DELETE FROM employee_ot_trainings WHERE employee_id = $1 AND kind = $2',
        [employeeId, kind],
      );
    } else {
      await client.query(
        `INSERT INTO employee_ot_trainings (employee_id, kind, passed_on, note, updated_by, updated_at)
         VALUES ($1, $2, $3::date, $4, $5::uuid, now())
         ON CONFLICT (employee_id, kind) DO UPDATE
            SET passed_on  = EXCLUDED.passed_on,
                note       = EXCLUDED.note,
                updated_by = EXCLUDED.updated_by,
                updated_at = now()`,
        [employeeId, kind, nextDate, nextNote, userId],
      );
    }

    // Dual-write в legacy-таблицу: на ней фильтры/счётчик вкладки и откат бэкенда.
    if (kind === 'introductory' || kind === 'program_a') {
      await syncLegacyInduction(client, employeeId, kind, nextDate, userId);
    }

    return { found: true, changed: true, diff };
  });
};

/**
 * Зеркалирование даты в employee_inductions. Ветка DELETE обязана идти до UPSERT: строка
 * без обеих дат нарушает employee_inductions_any_date_chk (миграция 233).
 */
const syncLegacyInduction = async (
  client: PoolClient,
  employeeId: number,
  kind: 'introductory' | 'program_a',
  value: string | null,
  userId: string,
): Promise<void> => {
  const current = await client.query<{ inducted_on: string | null; program_a_on: string | null }>(
    `SELECT to_char(inducted_on, 'YYYY-MM-DD') AS inducted_on,
            to_char(program_a_on, 'YYYY-MM-DD') AS program_a_on
       FROM employee_inductions
      WHERE employee_id = $1
      FOR UPDATE`,
    [employeeId],
  );
  const inducted = kind === 'introductory' ? value : current.rows[0]?.inducted_on ?? null;
  const programA = kind === 'program_a' ? value : current.rows[0]?.program_a_on ?? null;

  if (inducted === null && programA === null) {
    await client.query('DELETE FROM employee_inductions WHERE employee_id = $1', [employeeId]);
    return;
  }

  await client.query(
    `INSERT INTO employee_inductions (employee_id, inducted_on, program_a_on, updated_by, updated_at)
     VALUES ($1, $2::date, $3::date, $4::uuid, now())
     ON CONFLICT (employee_id) DO UPDATE
        SET inducted_on  = EXCLUDED.inducted_on,
            program_a_on = EXCLUDED.program_a_on,
            updated_by   = EXCLUDED.updated_by,
            updated_at   = now()`,
    [employeeId, inducted, programA, userId],
  );
};
