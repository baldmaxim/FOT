/**
 * Опросники («тесты») — данные и транзакционные операции.
 * Тесты без оценки: вопросы single/multiple/text, варианты ответов,
 * назначение на отделы (наследуется потомками), прохождения сотрудников.
 */
import { query, queryOne, withTransaction } from '../config/postgres.js';

export type QuestionType = 'single' | 'multiple' | 'text';

export interface ITestOptionInput {
  text: string;
}
export interface ITestQuestionInput {
  text: string;
  type: QuestionType;
  allow_custom?: boolean;
  is_required?: boolean;
  options?: ITestOptionInput[];
}
export interface ITestInput {
  title: string;
  description?: string | null;
  active_from?: string | null;
  active_to?: string | null;
  questions: ITestQuestionInput[];
}

export interface ITestFull {
  id: string;
  title: string;
  description: string | null;
  active_from: string | null;
  active_to: string | null;
  is_active: boolean;
  questions: Array<{
    id: string;
    position: number;
    text: string;
    type: QuestionType;
    allow_custom: boolean;
    is_required: boolean;
    options: Array<{ id: string; position: number; text: string }>;
  }>;
}

const nowIso = (): string => new Date().toISOString();

// ---- Чтение полного теста (вопросы + варианты) ----
export async function loadTestFull(testId: string): Promise<ITestFull | null> {
  const test = await queryOne<{
    id: string; title: string; description: string | null;
    active_from: string | null; active_to: string | null; is_active: boolean;
  }>(
    `SELECT id, title, description, active_from, active_to, is_active
       FROM tests WHERE id = $1::uuid`,
    [testId],
  );
  if (!test) return null;

  const questions = await query<{
    id: string; position: number; text: string;
    type: QuestionType; allow_custom: boolean; is_required: boolean;
  }>(
    `SELECT id, position, text, type, allow_custom, is_required
       FROM test_questions WHERE test_id = $1::uuid ORDER BY position, id`,
    [testId],
  );
  const qIds = questions.map(q => q.id);
  const options = qIds.length > 0
    ? await query<{ id: string; question_id: string; position: number; text: string }>(
        `SELECT id, question_id, position, text
           FROM test_options WHERE question_id = ANY($1::uuid[]) ORDER BY position, id`,
        [qIds],
      )
    : [];
  const byQuestion = new Map<string, Array<{ id: string; position: number; text: string }>>();
  for (const o of options) {
    const list = byQuestion.get(o.question_id) ?? [];
    list.push({ id: o.id, position: o.position, text: o.text });
    byQuestion.set(o.question_id, list);
  }

  return {
    ...test,
    questions: questions.map(q => ({ ...q, options: byQuestion.get(q.id) ?? [] })),
  };
}

// ---- Создание теста (одна транзакция) ----
export async function createTest(params: {
  input: ITestInput;
  createdByUserId: string;
  companyRootId: string | null;
}): Promise<string> {
  const { input } = params;
  return withTransaction(async (client) => {
    const testRow = await client.query<{ id: string }>(
      `INSERT INTO tests (title, description, active_from, active_to, created_by_user_id, company_root_id)
       VALUES ($1, $2, $3::timestamptz, $4::timestamptz, $5::uuid, $6::uuid)
       RETURNING id`,
      [input.title, input.description ?? null, input.active_from ?? null,
        input.active_to ?? null, params.createdByUserId, params.companyRootId],
    );
    const testId = testRow.rows[0].id;
    await insertQuestions(client, testId, input.questions);
    return testId;
  });
}

// ---- Обновление теста: replace вопросов/вариантов ----
export async function updateTest(testId: string, input: ITestInput): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE tests SET title = $2, description = $3,
              active_from = $4::timestamptz, active_to = $5::timestamptz, updated_at = $6::timestamptz
        WHERE id = $1::uuid`,
      [testId, input.title, input.description ?? null, input.active_from ?? null,
        input.active_to ?? null, nowIso()],
    );
    // Полная замена вопросов (CASCADE снимет варианты и ответы прохождений).
    await client.query('DELETE FROM test_questions WHERE test_id = $1::uuid', [testId]);
    await insertQuestions(client, testId, input.questions);
  });
}

async function insertQuestions(
  client: import('pg').PoolClient,
  testId: string,
  questions: ITestQuestionInput[],
): Promise<void> {
  for (let qi = 0; qi < questions.length; qi += 1) {
    const q = questions[qi];
    const qRow = await client.query<{ id: string }>(
      `INSERT INTO test_questions (test_id, position, text, type, allow_custom, is_required)
       VALUES ($1::uuid, $2, $3, $4, $5, $6) RETURNING id`,
      [testId, qi, q.text, q.type, q.allow_custom ?? false, q.is_required ?? true],
    );
    const questionId = qRow.rows[0].id;
    const options = q.type === 'text' ? [] : (q.options ?? []);
    for (let oi = 0; oi < options.length; oi += 1) {
      await client.query(
        `INSERT INTO test_options (question_id, position, text) VALUES ($1::uuid, $2, $3)`,
        [questionId, oi, options[oi].text],
      );
    }
  }
}

// ---- Доступные сотруднику тесты (по цепочке его отдела вверх) ----
export async function listAvailableTests(employeeId: number, departmentId: string | null): Promise<Array<{
  id: string; title: string; description: string | null;
  active_from: string | null; active_to: string | null; my_status: string | null;
}>> {
  if (!departmentId) return [];
  return query(
    `WITH RECURSIVE chain AS (
       SELECT id, parent_id FROM org_departments WHERE id = $1::uuid
       UNION ALL
       SELECT d.id, d.parent_id FROM org_departments d JOIN chain c ON d.id = c.parent_id
     )
     SELECT DISTINCT t.id, t.title, t.description, t.active_from, t.active_to,
            r.status AS my_status
       FROM test_assignments a
       JOIN tests t ON t.id = a.test_id AND t.is_active = true
       LEFT JOIN test_responses r ON r.test_id = t.id AND r.employee_id = $2
      WHERE a.is_active = true
        AND a.department_id IN (SELECT id FROM chain)
        AND (t.active_from IS NULL OR t.active_from <= now())
        AND (t.active_to IS NULL OR t.active_to >= now())
      ORDER BY t.title`,
    [departmentId, employeeId],
  );
}

// ---- Назначен ли тест на отдел сотрудника (через цепочку) ----
export async function isTestAssignedToDepartmentChain(testId: string, departmentId: string | null): Promise<boolean> {
  if (!departmentId) return false;
  const row = await queryOne<{ ok: boolean }>(
    `WITH RECURSIVE chain AS (
       SELECT id, parent_id FROM org_departments WHERE id = $1::uuid
       UNION ALL
       SELECT d.id, d.parent_id FROM org_departments d JOIN chain c ON d.id = c.parent_id
     )
     SELECT EXISTS (
       SELECT 1 FROM test_assignments a
        WHERE a.test_id = $2::uuid AND a.is_active = true
          AND a.department_id IN (SELECT id FROM chain)
     ) AS ok`,
    [departmentId, testId],
  );
  return row?.ok ?? false;
}

// ---- Мой ответ (черновик/финал) ----
export async function loadMyResponse(testId: string, employeeId: number): Promise<{
  status: string;
  answers: Array<{ question_id: string; selected_option_ids: string[]; custom_text: string | null }>;
} | null> {
  const resp = await queryOne<{ id: string; status: string }>(
    `SELECT id, status FROM test_responses WHERE test_id = $1::uuid AND employee_id = $2`,
    [testId, employeeId],
  );
  if (!resp) return null;
  const answers = await query<{ question_id: string; selected_option_ids: string[]; custom_text: string | null }>(
    `SELECT question_id, selected_option_ids, custom_text FROM test_answers WHERE response_id = $1::uuid`,
    [resp.id],
  );
  return { status: resp.status, answers };
}

// ---- Прохождение конкретного сотрудника (для просмотра администратором) ----
export async function loadResponseDetail(testId: string, responseId: string): Promise<{
  full_name: string | null;
  status: string;
  submitted_at: string | null;
  answers: Array<{ question_id: string; selected_option_ids: string[]; custom_text: string | null }>;
} | null> {
  const resp = await queryOne<{ full_name: string | null; status: string; submitted_at: string | null }>(
    `SELECT e.full_name, r.status, r.submitted_at
       FROM test_responses r
       JOIN employees e ON e.id = r.employee_id
      WHERE r.id = $1::uuid AND r.test_id = $2::uuid`,
    [responseId, testId],
  );
  if (!resp) return null;
  const answers = await query<{ question_id: string; selected_option_ids: string[]; custom_text: string | null }>(
    `SELECT question_id, selected_option_ids, custom_text FROM test_answers WHERE response_id = $1::uuid`,
    [responseId],
  );
  return { ...resp, answers };
}

export interface IAnswerInput {
  question_id: string;
  selected_option_ids?: string[];
  custom_text?: string | null;
}

// ---- Сохранение прохождения (черновик/финал) ----
export async function saveResponse(params: {
  testId: string;
  employeeId: number;
  departmentId: string | null;
  status: 'draft' | 'submitted';
  answers: IAnswerInput[];
}): Promise<void> {
  await withTransaction(async (client) => {
    const existing = await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM test_responses WHERE test_id = $1::uuid AND employee_id = $2 FOR UPDATE`,
      [params.testId, params.employeeId],
    );
    if (existing.rows[0]?.status === 'submitted') {
      throw new Error('ALREADY_SUBMITTED');
    }

    const submittedAt = params.status === 'submitted' ? nowIso() : null;
    let responseId: string;
    if (existing.rows[0]) {
      responseId = existing.rows[0].id;
      await client.query(
        `UPDATE test_responses SET status = $2, submitted_at = $3::timestamptz, updated_at = now()
          WHERE id = $1::uuid`,
        [responseId, params.status, submittedAt],
      );
    } else {
      const ins = await client.query<{ id: string }>(
        `INSERT INTO test_responses (test_id, employee_id, status, department_id, submitted_at)
         VALUES ($1::uuid, $2, $3, $4::uuid, $5::timestamptz) RETURNING id`,
        [params.testId, params.employeeId, params.status, params.departmentId, submittedAt],
      );
      responseId = ins.rows[0].id;
    }

    await client.query('DELETE FROM test_answers WHERE response_id = $1::uuid', [responseId]);
    for (const a of params.answers) {
      const opts = (a.selected_option_ids ?? []).filter(Boolean);
      const text = a.custom_text?.trim() || null;
      if (opts.length === 0 && !text) continue;
      await client.query(
        `INSERT INTO test_answers (response_id, question_id, selected_option_ids, custom_text)
         VALUES ($1::uuid, $2::uuid, $3::uuid[], $4)`,
        [responseId, a.question_id, opts, text],
      );
    }
  });
}
