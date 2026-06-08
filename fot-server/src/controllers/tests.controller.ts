import type { Response } from 'express';
import { z } from 'zod';
import { query, queryOne, execute } from '../config/postgres.js';
import type { AuthenticatedRequest } from '../types/index.js';
import {
  resolveCompanyScope,
  resolveAccessibleDepartmentIds,
} from '../services/data-scope.service.js';
import { feedbackController } from './feedback.controller.js';
import {
  loadTestFull,
  createTest,
  updateTest,
  listAvailableTests,
  isTestAssignedToDepartmentChain,
  loadMyResponse,
  loadResponseDetail,
  saveResponse,
} from '../services/tests.service.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

const optionSchema = z.object({ text: z.string().trim().min(1) });
const questionSchema = z.object({
  text: z.string().trim().min(1),
  type: z.enum(['single', 'multiple', 'text']),
  allow_custom: z.boolean().optional().default(false),
  is_required: z.boolean().optional().default(true),
  options: z.array(optionSchema).optional().default([]),
}).superRefine((q, ctx) => {
  if (q.type !== 'text' && q.options.length < 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['options'], message: 'Нужен хотя бы один вариант ответа' });
  }
});
const testSchema = z.object({
  title: z.string().trim().min(1),
  description: z.string().trim().optional().nullable(),
  active_from: z.string().datetime().optional().nullable(),
  active_to: z.string().datetime().optional().nullable(),
  questions: z.array(questionSchema).min(1),
});

const responseSchema = z.object({
  status: z.enum(['draft', 'submitted']),
  answers: z.array(z.object({
    question_id: z.string(),
    selected_option_ids: z.array(z.string()).optional().default([]),
    custom_text: z.string().optional().nullable(),
  })).default([]),
});

// ============================ Сотрудник ============================

const getAvailable = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const employeeId = req.user.employee_id;
    if (!employeeId) {
      res.json({ success: true, data: [] });
      return;
    }
    const emp = await queryOne<{ org_department_id: string | null }>(
      'SELECT org_department_id FROM employees WHERE id = $1',
      [employeeId],
    );
    const data = await listAvailableTests(employeeId, emp?.org_department_id ?? null);
    res.json({ success: true, data });
  } catch (err) {
    console.error('tests.getAvailable error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения тестов' });
  }
};

const takeTest = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const testId = req.params.id;
    if (!isUuid(testId)) { res.status(400).json({ success: false, error: 'Некорректный id' }); return; }
    const employeeId = req.user.employee_id;
    const emp = employeeId
      ? await queryOne<{ org_department_id: string | null }>('SELECT org_department_id FROM employees WHERE id = $1', [employeeId])
      : null;
    const assigned = await isTestAssignedToDepartmentChain(testId, emp?.org_department_id ?? null);
    if (!assigned) { res.status(403).json({ success: false, error: 'Тест не назначен' }); return; }
    const test = await loadTestFull(testId);
    if (!test || !test.is_active) { res.status(404).json({ success: false, error: 'Тест не найден' }); return; }
    res.json({ success: true, data: test });
  } catch (err) {
    console.error('tests.takeTest error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения теста' });
  }
};

const getMyResponse = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const testId = req.params.id;
    if (!isUuid(testId)) { res.status(400).json({ success: false, error: 'Некорректный id' }); return; }
    const employeeId = req.user.employee_id;
    if (!employeeId) { res.json({ success: true, data: null }); return; }
    const data = await loadMyResponse(testId, employeeId);
    res.json({ success: true, data });
  } catch (err) {
    console.error('tests.getMyResponse error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения ответов' });
  }
};

const submitResponse = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const testId = req.params.id;
    if (!isUuid(testId)) { res.status(400).json({ success: false, error: 'Некорректный id' }); return; }
    const employeeId = req.user.employee_id;
    if (!employeeId) { res.status(400).json({ success: false, error: 'Нет привязки к сотруднику' }); return; }

    const parsed = responseSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ success: false, error: parsed.error.flatten() }); return; }

    const emp = await queryOne<{ org_department_id: string | null }>('SELECT org_department_id FROM employees WHERE id = $1', [employeeId]);
    const assigned = await isTestAssignedToDepartmentChain(testId, emp?.org_department_id ?? null);
    if (!assigned) { res.status(403).json({ success: false, error: 'Тест не назначен' }); return; }

    // Валидация обязательных вопросов при финальной отправке.
    if (parsed.data.status === 'submitted') {
      const test = await loadTestFull(testId);
      if (!test) { res.status(404).json({ success: false, error: 'Тест не найден' }); return; }
      const answered = new Map(parsed.data.answers.map(a => [a.question_id, a]));
      for (const q of test.questions) {
        if (!q.is_required) continue;
        const a = answered.get(q.id);
        const hasOpts = (a?.selected_option_ids ?? []).length > 0;
        const hasText = !!a?.custom_text?.trim();
        if (!hasOpts && !hasText) {
          res.status(400).json({ success: false, error: 'Ответьте на все обязательные вопросы' });
          return;
        }
      }
    }

    await saveResponse({
      testId,
      employeeId,
      departmentId: emp?.org_department_id ?? null,
      status: parsed.data.status,
      answers: parsed.data.answers,
    });
    res.json({ success: true });
  } catch (err) {
    if (err instanceof Error && err.message === 'ALREADY_SUBMITTED') {
      res.status(409).json({ success: false, error: 'Тест уже отправлен' });
      return;
    }
    console.error('tests.submitResponse error:', err);
    res.status(500).json({ success: false, error: 'Ошибка сохранения' });
  }
};

// ============================ Админ: управление ============================

// Может ли админ управлять тестом (в его company-скоупе).
async function canManageTest(req: AuthenticatedRequest, testId: string): Promise<boolean> {
  const scope = await resolveCompanyScope(req);
  if (scope.roots === 'all') return true;
  const row = await queryOne<{ company_root_id: string | null }>(
    'SELECT company_root_id FROM tests WHERE id = $1::uuid', [testId],
  );
  if (!row) return false;
  return row.company_root_id != null && scope.roots.includes(row.company_root_id);
}

const listTests = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const scope = await resolveCompanyScope(req);
    const params: unknown[] = [];
    let whereCompany = '';
    if (scope.roots !== 'all') {
      if (scope.roots.length === 0) { res.json({ success: true, data: [] }); return; }
      params.push(scope.roots);
      whereCompany = `WHERE t.company_root_id = ANY($1::uuid[])`;
    }
    const data = await query(
      `SELECT t.id, t.title, t.description, t.active_from, t.active_to, t.is_active, t.created_at,
              (SELECT COUNT(*)::int FROM test_questions q WHERE q.test_id = t.id) AS question_count,
              (SELECT COUNT(*)::int FROM test_assignments a WHERE a.test_id = t.id AND a.is_active = true) AS assignment_count,
              (SELECT COUNT(*)::int FROM test_responses r WHERE r.test_id = t.id AND r.status = 'submitted') AS submitted_count,
              COALESCE((
                SELECT array_agg(a.department_id) FROM test_assignments a
                 WHERE a.test_id = t.id AND a.is_active = true
              ), '{}') AS department_ids
         FROM tests t
         ${whereCompany}
        ORDER BY t.created_at DESC`,
      params,
    );
    res.json({ success: true, data });
  } catch (err) {
    console.error('tests.listTests error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения тестов' });
  }
};

const getTestFull = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const testId = req.params.id;
    if (!isUuid(testId)) { res.status(400).json({ success: false, error: 'Некорректный id' }); return; }
    if (!(await canManageTest(req, testId))) { res.status(403).json({ success: false, error: 'Нет доступа' }); return; }
    const test = await loadTestFull(testId);
    if (!test) { res.status(404).json({ success: false, error: 'Тест не найден' }); return; }
    const assignRows = await query<{ department_id: string }>(
      'SELECT department_id FROM test_assignments WHERE test_id = $1::uuid AND is_active = true', [testId],
    );
    res.json({ success: true, data: { ...test, department_ids: assignRows.map(r => r.department_id) } });
  } catch (err) {
    console.error('tests.getTestFull error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения теста' });
  }
};

const create = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const parsed = testSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ success: false, error: parsed.error.flatten() }); return; }
    const scope = await resolveCompanyScope(req);
    const companyRootId = scope.roots === 'all' ? null : (scope.roots[0] ?? null);
    const id = await createTest({ input: parsed.data, createdByUserId: req.user.id, companyRootId });
    res.json({ success: true, data: { id } });
  } catch (err) {
    console.error('tests.create error:', err);
    res.status(500).json({ success: false, error: 'Ошибка создания теста' });
  }
};

const update = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const testId = req.params.id;
    if (!isUuid(testId)) { res.status(400).json({ success: false, error: 'Некорректный id' }); return; }
    if (!(await canManageTest(req, testId))) { res.status(403).json({ success: false, error: 'Нет доступа' }); return; }
    const parsed = testSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ success: false, error: parsed.error.flatten() }); return; }
    await updateTest(testId, parsed.data);
    res.json({ success: true });
  } catch (err) {
    console.error('tests.update error:', err);
    res.status(500).json({ success: false, error: 'Ошибка обновления теста' });
  }
};

const deactivate = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const testId = req.params.id;
    if (!isUuid(testId)) { res.status(400).json({ success: false, error: 'Некорректный id' }); return; }
    if (!(await canManageTest(req, testId))) { res.status(403).json({ success: false, error: 'Нет доступа' }); return; }
    await execute('UPDATE tests SET is_active = false, updated_at = now() WHERE id = $1::uuid', [testId]);
    res.json({ success: true });
  } catch (err) {
    console.error('tests.deactivate error:', err);
    res.status(500).json({ success: false, error: 'Ошибка удаления теста' });
  }
};

const setAssignments = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const testId = req.params.id;
    if (!isUuid(testId)) { res.status(400).json({ success: false, error: 'Некорректный id' }); return; }
    if (!(await canManageTest(req, testId))) { res.status(403).json({ success: false, error: 'Нет доступа' }); return; }

    const schema = z.object({ department_ids: z.array(z.string().uuid()).default([]) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ success: false, error: parsed.error.flatten() }); return; }

    // Ограничиваем назначаемые отделы скоупом администратора.
    const accessible = await resolveAccessibleDepartmentIds(req);
    let next = [...new Set(parsed.data.department_ids)];
    if (accessible !== 'all') {
      const allowed = new Set(accessible);
      next = next.filter(id => allowed.has(id));
    }

    const existing = await query<{ department_id: string; is_active: boolean }>(
      'SELECT department_id, is_active FROM test_assignments WHERE test_id = $1::uuid', [testId],
    );
    const nextSet = new Set(next);
    const toDeactivate = existing.filter(r => r.is_active).map(r => r.department_id).filter(id => !nextSet.has(id));

    if (next.length > 0) {
      await execute(
        `INSERT INTO test_assignments (test_id, department_id, is_active, created_by, updated_at)
         SELECT $1::uuid, dep_id, true, $2::uuid, now() FROM unnest($3::uuid[]) AS dep_id
         ON CONFLICT (test_id, department_id)
         DO UPDATE SET is_active = true, updated_at = now()`,
        [testId, req.user.id, next],
      );
    }
    if (toDeactivate.length > 0) {
      await execute(
        `UPDATE test_assignments SET is_active = false, updated_at = now()
          WHERE test_id = $1::uuid AND department_id = ANY($2::uuid[])`,
        [testId, toDeactivate],
      );
    }
    res.json({ success: true, data: { department_ids: next } });
  } catch (err) {
    console.error('tests.setAssignments error:', err);
    res.status(500).json({ success: false, error: 'Ошибка назначения' });
  }
};

// Прохождения теста (для просмотра администратором).
const listResponses = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const testId = req.params.id;
    if (!isUuid(testId)) { res.status(400).json({ success: false, error: 'Некорректный id' }); return; }
    if (!(await canManageTest(req, testId))) { res.status(403).json({ success: false, error: 'Нет доступа' }); return; }
    const data = await query(
      `SELECT r.id, r.status, r.submitted_at, r.updated_at,
              e.full_name, d.name AS department_name
         FROM test_responses r
         JOIN employees e ON e.id = r.employee_id
         LEFT JOIN org_departments d ON d.id = e.org_department_id
        WHERE r.test_id = $1::uuid
        ORDER BY r.submitted_at DESC NULLS LAST, e.full_name`,
      [testId],
    );
    res.json({ success: true, data });
  } catch (err) {
    console.error('tests.listResponses error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения прохождений' });
  }
};

// Детали прохождения конкретного сотрудника (вопросы + его ответы).
const getResponseDetail = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const testId = req.params.id;
    const responseId = req.params.responseId;
    if (!isUuid(testId) || !isUuid(responseId)) { res.status(400).json({ success: false, error: 'Некорректный id' }); return; }
    if (!(await canManageTest(req, testId))) { res.status(403).json({ success: false, error: 'Нет доступа' }); return; }
    const test = await loadTestFull(testId);
    if (!test) { res.status(404).json({ success: false, error: 'Тест не найден' }); return; }
    const response = await loadResponseDetail(testId, responseId);
    if (!response) { res.status(404).json({ success: false, error: 'Прохождение не найдено' }); return; }
    res.json({ success: true, data: { test, response } });
  } catch (err) {
    console.error('tests.getResponseDetail error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения прохождения' });
  }
};

// Удаление прохождения сотрудника (CASCADE снимет ответы).
const deleteResponse = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const testId = req.params.id;
    const responseId = req.params.responseId;
    if (!isUuid(testId) || !isUuid(responseId)) { res.status(400).json({ success: false, error: 'Некорректный id' }); return; }
    if (!(await canManageTest(req, testId))) { res.status(403).json({ success: false, error: 'Нет доступа' }); return; }
    await execute('DELETE FROM test_responses WHERE id = $1::uuid AND test_id = $2::uuid', [responseId, testId]);
    res.json({ success: true });
  } catch (err) {
    console.error('tests.deleteResponse error:', err);
    res.status(500).json({ success: false, error: 'Ошибка удаления прохождения' });
  }
};

// Статистика прохождения по отделам (выполнили / всего) в скоупе.
const getStats = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const testId = typeof req.query.test_id === 'string' ? req.query.test_id : '';
    if (!isUuid(testId)) { res.status(400).json({ success: false, error: 'Не указан тест' }); return; }

    const { resolveAccessibleEmployeeIds } = await import('../services/data-scope.service.js');
    const accessible = await resolveAccessibleEmployeeIds(req);
    const scope = accessible === 'all'
      ? { all: true as const }
      : { all: false as const, ids: [...accessible] };
    if (!scope.all && scope.ids.length === 0) { res.json({ success: true, data: [] }); return; }

    const stats = await feedbackController.buildDepartmentStats(req, scope, {
      filledExpr: `EXISTS (
        SELECT 1 FROM test_responses r
         WHERE r.employee_id = e.id AND r.test_id = '${testId}'::uuid AND r.status = 'submitted'
      )`,
    });
    res.json({ success: true, data: stats });
  } catch (err) {
    console.error('tests.getStats error:', err);
    res.status(500).json({ success: false, error: 'Ошибка статистики' });
  }
};

export const testsController = {
  getAvailable,
  takeTest,
  getMyResponse,
  submitResponse,
  listTests,
  getTestFull,
  create,
  update,
  deactivate,
  setAssignments,
  listResponses,
  getResponseDetail,
  deleteResponse,
  getStats,
};
