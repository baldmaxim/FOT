/**
 * Реестр обучения по ОТ сотрудников подрядчиков (вкладка «Подрядчики → ОТиТБ»).
 *
 * Даты живут в contractor_person_trainings (миграция 232), по строке на вид обучения;
 * снятие даты = DELETE строки. Родительская запись — contractor_inducted_persons.
 *
 * Два обязательства перед переходным периодом:
 *   1. dual-write: вводный инструктаж пишется и в legacy-колонку inducted_on, поэтому
 *      откат бэкенда не теряет данные (колонка снимается уборочной миграцией);
 *   2. удаление — только архивирование (deleted_at), иначе каскад уносит всю историю обучения.
 */
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../config/postgres.js';
import {
  OT_CONTRACTOR_KINDS,
  otTrainingDef,
  summarizeOtPerson,
  type IOtPersonSummary,
  type OtTrainingKind,
} from './ot-training.service.js';

/** Ревизия записи для optimistic concurrency: строка одного формата на чтении и записи. */
const UPDATED_AT_ISO = `to_char(p.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export interface IInductedPerson extends IOtPersonSummary {
  id: string;
  full_name: string;
  updated_at: string;
  /** deprecated: дата вводного инструктажа отдельным полем — для старого фронта. */
  inducted_on: string | null;
}

export interface IInductedPersonFull extends IInductedPerson {
  org_department_id: string;
  org_name: string;
}

export interface IInductionOrgCounts {
  total: number;
  alert: number;
  warning: number;
}

interface IPersonRow {
  id: string;
  org_department_id: string;
  full_name: string;
  updated_at: string;
  org_name?: string;
}

interface ITrainingRow {
  person_id: string;
  kind: string;
  passed_on: string;
}

/** Даты обучения по списку персон, сгруппированные person_id → (kind → passed_on). */
const loadTrainings = async (personIds: string[]): Promise<Map<string, Map<string, string>>> => {
  const byPerson = new Map<string, Map<string, string>>();
  if (personIds.length === 0) return byPerson;

  const rows = await query<ITrainingRow>(
    `SELECT person_id, kind, to_char(passed_on, 'YYYY-MM-DD') AS passed_on
       FROM contractor_person_trainings
      WHERE person_id = ANY($1::uuid[])`,
    [personIds],
  );
  for (const r of rows) {
    let map = byPerson.get(r.person_id);
    if (!map) {
      map = new Map<string, string>();
      byPerson.set(r.person_id, map);
    }
    map.set(r.kind, r.passed_on);
  }
  return byPerson;
};

const toPerson = (
  row: IPersonRow,
  passed: ReadonlyMap<string, string>,
  todayIso: string,
): IInductedPerson => ({
  id: row.id,
  full_name: row.full_name,
  updated_at: row.updated_at,
  inducted_on: passed.get('introductory') ?? null,
  ...summarizeOtPerson('contractor', passed, todayIso),
});

const EMPTY = new Map<string, string>();

/** Реестр одной организации. Архивные записи не отдаются. */
export const listInductedByOrg = async (
  orgId: string,
  todayIso: string,
): Promise<IInductedPerson[]> => {
  const rows = await query<IPersonRow>(
    `SELECT p.id, p.org_department_id, p.full_name, ${UPDATED_AT_ISO} AS updated_at
       FROM contractor_inducted_persons p
      WHERE p.org_department_id = $1::uuid AND p.deleted_at IS NULL
      ORDER BY p.full_name ASC`,
    [orgId],
  );
  const trainings = await loadTrainings(rows.map(r => r.id));
  return rows.map(r => toPerson(r, trainings.get(r.id) ?? EMPTY, todayIso));
};

/** Плоский список по всем подрядным организациям (режим «показать всех»). */
export const listAllInducted = async (
  orgIds: string[],
  todayIso: string,
): Promise<IInductedPersonFull[]> => {
  if (orgIds.length === 0) return [];
  const rows = await query<Required<IPersonRow>>(
    `SELECT p.id, p.org_department_id, p.full_name, od.name AS org_name,
            ${UPDATED_AT_ISO} AS updated_at
       FROM contractor_inducted_persons p
       JOIN org_departments od ON od.id = p.org_department_id
      WHERE p.org_department_id = ANY($1::uuid[]) AND p.deleted_at IS NULL
      ORDER BY od.name ASC, p.full_name ASC`,
    [orgIds],
  );
  const trainings = await loadTrainings(rows.map(r => r.id));
  return rows.map(r => ({
    ...toPerson(r, trainings.get(r.id) ?? EMPTY, todayIso),
    org_department_id: r.org_department_id,
    org_name: r.org_name,
  }));
};

/**
 * Счётчики по организациям: всего в реестре и сколько требуют внимания. Без них
 * проблему видно только раскрыв организацию — требование «подсветить отсутствие обучения».
 */
export const countInductionByOrg = async (
  orgIds: string[],
  todayIso: string,
): Promise<Map<string, IInductionOrgCounts>> => {
  const result = new Map<string, IInductionOrgCounts>();
  if (orgIds.length === 0) return result;

  const rows = await query<IPersonRow>(
    `SELECT p.id, p.org_department_id, p.full_name, ${UPDATED_AT_ISO} AS updated_at
       FROM contractor_inducted_persons p
      WHERE p.org_department_id = ANY($1::uuid[]) AND p.deleted_at IS NULL`,
    [orgIds],
  );
  const trainings = await loadTrainings(rows.map(r => r.id));

  for (const row of rows) {
    const summary = summarizeOtPerson('contractor', trainings.get(row.id) ?? EMPTY, todayIso);
    const acc = result.get(row.org_department_id) ?? { total: 0, alert: 0, warning: 0 };
    acc.total += 1;
    if (summary.row_status === 'alert') acc.alert += 1;
    else if (summary.row_status === 'warning') acc.warning += 1;
    result.set(row.org_department_id, acc);
  }
  return result;
};

/** Изменения по видам обучения для аудита: kind → { from, to }. */
export type OtChangeDiff = Record<string, { from: string | null; to: string | null }>;

/** Патч дат: ключ отсутствует — вид не трогаем, null — снять дату. */
export type OtTrainingsPatch = Partial<Record<OtTrainingKind, string | null>>;

const assertContractorKinds = (patch: OtTrainingsPatch): void => {
  for (const kind of Object.keys(patch)) {
    const def = otTrainingDef(kind);
    if (!def || def.audience !== 'all') {
      throw new OtTrainingKindError(`Вид обучения «${def?.label ?? kind}» не применяется к рабочим`);
    }
  }
};

export class OtTrainingKindError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OtTrainingKindError';
  }
}

/**
 * Применение патча дат в открытой транзакции. Возвращает диф изменений;
 * пустой диф — писать нечего (аудит и bump updated_at пропускаем).
 */
const applyTrainings = async (
  client: PoolClient,
  personId: string,
  patch: OtTrainingsPatch,
  userId: string,
): Promise<OtChangeDiff> => {
  const kinds = Object.keys(patch) as OtTrainingKind[];
  if (kinds.length === 0) return {};

  const prev = await client.query<{ kind: string; passed_on: string }>(
    `SELECT kind, to_char(passed_on, 'YYYY-MM-DD') AS passed_on
       FROM contractor_person_trainings
      WHERE person_id = $1::uuid AND kind = ANY($2::text[])
      FOR UPDATE`,
    [personId, kinds],
  );
  const before = new Map(prev.rows.map(r => [r.kind, r.passed_on]));

  const diff: OtChangeDiff = {};
  for (const kind of kinds) {
    const next = patch[kind] ?? null;
    const from = before.get(kind) ?? null;
    // Значение не меняется — не трогаем строку, иначе updated_by/updated_at «правкой»,
    // которой не было (тот же приём, что в employee-induction.service).
    if (from === next) continue;

    if (next === null) {
      await client.query(
        'DELETE FROM contractor_person_trainings WHERE person_id = $1::uuid AND kind = $2',
        [personId, kind],
      );
    } else {
      await client.query(
        `INSERT INTO contractor_person_trainings (person_id, kind, passed_on, updated_by, updated_at)
         VALUES ($1::uuid, $2, $3::date, $4::uuid, now())
         ON CONFLICT (person_id, kind) DO UPDATE
            SET passed_on  = EXCLUDED.passed_on,
                updated_by = EXCLUDED.updated_by,
                updated_at = now()`,
        [personId, kind, next, userId],
      );
    }
    diff[kind] = { from, to: next };
  }

  // Dual-write вводного инструктажа в legacy-колонку: без него откат бэкенда потеряет дату.
  if (diff.introductory) {
    await client.query(
      'UPDATE contractor_inducted_persons SET inducted_on = $2::date WHERE id = $1::uuid',
      [personId, diff.introductory.to],
    );
  }
  return diff;
};

export interface ICreatePersonInput {
  orgDepartmentId: string;
  fullName: string;
  trainings: OtTrainingsPatch;
  userId: string;
}

/** Создание записи реестра вместе с датами обучения. */
export const createInductedPerson = async (
  input: ICreatePersonInput,
): Promise<{ id: string; diff: OtChangeDiff }> => {
  assertContractorKinds(input.trainings);

  return withTransaction(async (client: PoolClient) => {
    const created = await client.query<{ id: string }>(
      `INSERT INTO contractor_inducted_persons (org_department_id, full_name, inducted_on, created_by)
       VALUES ($1::uuid, $2, NULL, $3::uuid)
       RETURNING id`,
      [input.orgDepartmentId, input.fullName, input.userId],
    );
    const id = created.rows[0].id;
    const diff = await applyTrainings(client, id, input.trainings, input.userId);
    return { id, diff };
  });
};

export interface IUpdatePersonInput {
  id: string;
  orgIds: string[];
  fullName?: string;
  trainings?: OtTrainingsPatch;
  expectedUpdatedAt: string;
  userId: string;
}

export type UpdatePersonResult =
  | { status: 'not_found' }
  | { status: 'conflict' }
  | { status: 'ok'; diff: OtChangeDiff; nameFrom: string | null };

/**
 * Правка ФИО и дат. Партиал: приходят только изменённые ключи — полная отправка формы
 * вернула бы устаревшие значения и затёрла чужую правку. Ревизия (updated_at) отсекает
 * сохранение поверх изменений, сделанных после загрузки формы.
 */
export const updateInductedPerson = async (
  input: IUpdatePersonInput,
): Promise<UpdatePersonResult> => {
  if (input.orgIds.length === 0) return { status: 'not_found' };
  if (input.trainings) assertContractorKinds(input.trainings);

  return withTransaction(async (client: PoolClient) => {
    const target = await client.query<{ full_name: string; updated_at: string }>(
      `SELECT p.full_name, ${UPDATED_AT_ISO} AS updated_at
         FROM contractor_inducted_persons p
        WHERE p.id = $1::uuid AND p.org_department_id = ANY($2::uuid[]) AND p.deleted_at IS NULL
        FOR UPDATE`,
      [input.id, input.orgIds],
    );
    if (target.rows.length === 0) return { status: 'not_found' };
    if (target.rows[0].updated_at !== input.expectedUpdatedAt) return { status: 'conflict' };

    const diff = input.trainings
      ? await applyTrainings(client, input.id, input.trainings, input.userId)
      : {};

    const prevName = target.rows[0].full_name;
    const nameFrom = input.fullName !== undefined && input.fullName !== prevName ? prevName : null;
    if (nameFrom !== null) {
      await client.query(
        'UPDATE contractor_inducted_persons SET full_name = $2 WHERE id = $1::uuid',
        [input.id, input.fullName],
      );
    }

    if (Object.keys(diff).length > 0 || nameFrom !== null) {
      await client.query(
        'UPDATE contractor_inducted_persons SET updated_at = now() WHERE id = $1::uuid',
        [input.id],
      );
    }
    return { status: 'ok', diff, nameFrom };
  });
};

export interface IArchivedSnapshot {
  id: string;
  full_name: string;
  org_department_id: string;
  trainings: Record<string, string>;
}

/**
 * Архивирование записи. Физического DELETE нет: каскад унёс бы всю историю обучения,
 * а она нужна как доказательная база по ОТ. Снимок возвращается для аудита.
 */
export const archiveInductedPerson = async (
  id: string,
  orgIds: string[],
  userId: string,
): Promise<IArchivedSnapshot | null> => {
  if (orgIds.length === 0) return null;

  return withTransaction(async (client: PoolClient) => {
    const target = await client.query<{ id: string; full_name: string; org_department_id: string }>(
      `SELECT p.id, p.full_name, p.org_department_id
         FROM contractor_inducted_persons p
        WHERE p.id = $1::uuid AND p.org_department_id = ANY($2::uuid[]) AND p.deleted_at IS NULL
        FOR UPDATE`,
      [id, orgIds],
    );
    if (target.rows.length === 0) return null;

    const rows = await client.query<{ kind: string; passed_on: string }>(
      `SELECT kind, to_char(passed_on, 'YYYY-MM-DD') AS passed_on
         FROM contractor_person_trainings WHERE person_id = $1::uuid`,
      [id],
    );
    await client.query(
      `UPDATE contractor_inducted_persons
          SET deleted_at = now(), deleted_by = $2::uuid, updated_at = now()
        WHERE id = $1::uuid`,
      [id, userId],
    );

    return {
      id: target.rows[0].id,
      full_name: target.rows[0].full_name,
      org_department_id: target.rows[0].org_department_id,
      trainings: Object.fromEntries(rows.rows.map(r => [r.kind, r.passed_on])),
    };
  });
};

export { OT_CONTRACTOR_KINDS };
