import { randomUUID } from 'node:crypto';
import * as Sentry from '@sentry/node';
import { z } from 'zod';
import { query, queryOne, execute, withTransaction } from '../config/postgres.js';
import { settingsService } from './settings.service.js';
import { adaptiveTestingLlmService, ADAPTIVE_PROMPT_VERSION } from './adaptive-testing-llm.service.js';
import type {
  AdaptiveCurrentState,
  AdaptiveQuestionType,
  IAdaptiveAnswerPayload,
  IAdaptiveAvailability,
  IAdaptiveCompetency,
  IAdaptiveCompetencyState,
  IAdaptiveProfileSnapshot,
  IAdaptiveQuestionOption,
  IAdaptiveQuestionRow,
  IAdaptiveSessionRow,
} from '../types/adaptive-testing.types.js';

const TOTAL_QUESTIONS = 10;
const SESSION_TTL_HOURS = 48;
const LEASE_MINUTES = 10;
const MAX_AUTO_ATTEMPTS = 2;
/** Ручной retry на сессию — жёстко в коде, не настройка. */
const MAX_MANUAL_RETRIES = 1;
/** Sweeper: не больше задач за тик — без всплеска запросов к прокси. */
const SWEEP_BATCH_LIMIT = 5;
/** Параллельные LLM-задачи (семафор). */
const MAX_CONCURRENT_LLM_TASKS = 3;
const SWEEP_INTERVAL_MS = 45_000;

/** Начало текущих суток Europe/Moscow (дневной лимит сессий). */
const MSK_DAY_START_SQL = `(date_trunc('day', now() AT TIME ZONE 'Europe/Moscow') AT TIME ZONE 'Europe/Moscow')`;

// ─── Семафор LLM-задач ───────────────────────────────────────────────────────

let runningLlmTasks = 0;
const taskQueue: Array<() => void> = [];

const withLlmSlot = async <T>(fn: () => Promise<T>): Promise<T> => {
  while (runningLlmTasks >= MAX_CONCURRENT_LLM_TASKS) {
    await new Promise<void>(resolve => taskQueue.push(resolve));
  }
  runningLlmTasks++;
  try {
    return await fn();
  } finally {
    runningLlmTasks--;
    const next = taskQueue.shift();
    if (next) next();
  }
};

// ─── Утилиты ─────────────────────────────────────────────────────────────────

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

/** Allowlist: пусто/нет ключа = никому; '*' = всем с page access; иначе CSV. */
export const isEmailAllowed = (rawAllowlist: string | null | undefined, email: string | null | undefined): boolean => {
  const raw = (rawAllowlist ?? '').trim();
  if (!raw) return false;
  if (raw === '*') return true;
  if (!email) return false;
  const target = normalizeEmail(email);
  return raw.split(',').map(normalizeEmail).filter(Boolean).includes(target);
};

// ─── Валидация ответа сотрудника (strict) ────────────────────────────────────

const singleAnswerZod = z.object({ type: z.literal('single'), optionId: z.string().min(1).max(4) }).strict();
const multipleAnswerZod = z.object({ type: z.literal('multiple'), optionIds: z.array(z.string().min(1).max(4)).min(1).max(8) }).strict();
const textAnswerZod = z.object({ type: z.literal('text'), text: z.string().min(1).max(4000) }).strict();

export const validateAnswerPayload = (
  raw: unknown,
  questionType: AdaptiveQuestionType,
  options: IAdaptiveQuestionOption[] | null,
): IAdaptiveAnswerPayload => {
  const optionIds = new Set((options ?? []).map(o => o.id));

  if (questionType === 'single') {
    const a = singleAnswerZod.parse(raw);
    if (!optionIds.has(a.optionId)) throw new Error('Выбран несуществующий вариант');
    return a;
  }
  if (questionType === 'multiple') {
    const a = multipleAnswerZod.parse(raw);
    const unique = Array.from(new Set(a.optionIds));
    if (!unique.every(id => optionIds.has(id))) throw new Error('Выбран несуществующий вариант');
    return { type: 'multiple', optionIds: unique };
  }
  const a = textAnswerZod.parse(raw);
  return a;
};

/** Балл закрытого вопроса (multiple — через Set, cap 100). */
export const scoreClosedAnswer = (
  payload: IAdaptiveAnswerPayload,
  correctOptionIds: string[],
): number => {
  const correct = new Set(correctOptionIds);
  if (payload.type === 'single') {
    return correct.has(payload.optionId) ? 100 : 0;
  }
  if (payload.type === 'multiple') {
    const selected = new Set(payload.optionIds);
    let hit = 0;
    let miss = 0;
    for (const id of selected) {
      if (correct.has(id)) hit++;
      else miss++;
    }
    if (correct.size === 0) return 0;
    return clamp(Math.round(((hit - miss) / correct.size) * 100), 0, 100);
  }
  throw new Error('text-ответ не оценивается сервером');
};

// ─── Алгоритм адаптации ──────────────────────────────────────────────────────

export interface INextQuestionSpec {
  competency: IAdaptiveCompetency;
  difficulty: number;
  type: AdaptiveQuestionType;
  seq: number;
}

/** Сложность после ответа: ≥85 → +1 (cap 3); 60–84 → без изменения; <60 → −1 (floor 1). */
export const adjustDifficulty = (current: number, score: number): number => {
  if (score >= 85) return clamp(current + 1, 1, 3);
  if (score < 60) return clamp(current - 1, 1, 3);
  return clamp(current, 1, 3);
};

/**
 * Тип вопроса — детерминированно от позиции (не от LLM): гарантированный
 * микс форматов. seq 4 и 8 — text, seq 2 и 6 — multiple, остальные — single.
 */
export const questionTypeForSeq = (seq: number): AdaptiveQuestionType => {
  if (seq === 4 || seq === 8) return 'text';
  if (seq === 2 || seq === 6) return 'multiple';
  return 'single';
};

/**
 * Выбор следующего вопроса. Двухшаговое правило:
 * 1) обязательное продолжение: последний score < 60 и < 2 вопросов подряд;
 * 2) иначе глобальный priority = 0.5×(100−avg) + 0.35×notAsked + 0.15×coverage.
 * avgScore непокрытой компетенции = 50; tie-break — порядок в профиле;
 * запрет 3-го вопроса подряд по одной компетенции.
 */
export const selectNextQuestion = (
  competencies: IAdaptiveCompetency[],
  state: Record<string, IAdaptiveCompetencyState>,
  askedHistory: { competencyKey: string; score: number | null }[],
  nextSeq: number,
): INextQuestionSpec => {
  if (competencies.length === 0) throw new Error('Профиль без компетенций');

  const last = askedHistory[askedHistory.length - 1] ?? null;
  let consecutive = 0;
  if (last) {
    for (let i = askedHistory.length - 1; i >= 0; i--) {
      if (askedHistory[i].competencyKey === last.competencyKey) consecutive++;
      else break;
    }
  }

  const type = questionTypeForSeq(nextSeq);

  const pick = (c: IAdaptiveCompetency): INextQuestionSpec => ({
    competency: c,
    difficulty: state[c.key]?.nextDifficulty ?? 1,
    type,
    seq: nextSeq,
  });

  // Шаг 1: обязательное продолжение слабой компетенции.
  if (last && last.score !== null && last.score < 60 && consecutive < 2) {
    const c = competencies.find(x => x.key === last.competencyKey);
    if (c) return pick(c);
  }

  // Шаг 2: глобальный выбор по priority.
  let best: IAdaptiveCompetency | null = null;
  let bestPriority = -Infinity;
  for (const c of competencies) {
    // Запрет 3-го подряд.
    if (last && c.key === last.competencyKey && consecutive >= 2) continue;

    const st = state[c.key];
    const asked = st?.askedCount ?? 0;
    const avg = asked > 0 && st ? st.scoreSum / asked : 50;
    const notAskedBonus = asked > 0 ? 0 : 100;
    const coveragePenalty = clamp(100 - 50 * asked, 0, 100);
    const priority = 0.5 * (100 - avg) + 0.35 * notAskedBonus + 0.15 * coveragePenalty;
    if (priority > bestPriority) {
      bestPriority = priority;
      best = c;
    }
  }

  return pick(best ?? competencies[0]);
};

/** Итог: среднее по покрытым компетенциям (не по вопросам). */
export const computeResultSummary = (
  competencies: IAdaptiveCompetency[],
  state: Record<string, IAdaptiveCompetencyState>,
): {
  overallScore: number;
  coveragePct: number;
  strengths: string[];
  weaknesses: string[];
  recommendations: string[];
} => {
  const covered = competencies.filter(c => (state[c.key]?.askedCount ?? 0) > 0);
  const avgOf = (key: string): number => {
    const st = state[key];
    if (!st || st.askedCount === 0) return 0;
    return st.scoreSum / st.askedCount;
  };

  const overallScore = covered.length > 0
    ? Math.round(covered.reduce((sum, c) => sum + avgOf(c.key), 0) / covered.length)
    : 0;
  const coveragePct = competencies.length > 0
    ? Math.round((covered.length / competencies.length) * 100)
    : 0;

  const strengths = covered.filter(c => avgOf(c.key) >= 75).map(c => c.name);
  const weakList = covered.filter(c => avgOf(c.key) < 60);
  const weaknesses = weakList.map(c => c.name);
  const recommendations = weakList.map(c =>
    c.description ? `Повторить «${c.name}»: ${c.description}` : `Повторить «${c.name}»`,
  );

  return { overallScore, coveragePct, strengths, weaknesses, recommendations };
};

// ─── Профили ─────────────────────────────────────────────────────────────────

interface IProfileRow {
  id: string;
  org_department_id: string;
  position_id: string | null;
  title: string;
  duties_text: string;
  competencies: IAdaptiveCompetency[];
  is_published: boolean;
}

/** Опубликованный профиль: точный (отдел+должность) → фоллбек (отдел, NULL). */
const findPublishedProfile = async (
  departmentId: string,
  positionId: string | null,
): Promise<IProfileRow | null> => {
  if (positionId) {
    const exact = await queryOne<IProfileRow>(
      `SELECT id, org_department_id, position_id, title, duties_text, competencies, is_published
         FROM adaptive_skill_profiles
        WHERE org_department_id = $1 AND position_id = $2 AND is_published = true`,
      [departmentId, positionId],
    );
    if (exact) return exact;
  }
  return queryOne<IProfileRow>(
    `SELECT id, org_department_id, position_id, title, duties_text, competencies, is_published
       FROM adaptive_skill_profiles
      WHERE org_department_id = $1 AND position_id IS NULL AND is_published = true`,
    [departmentId],
  );
};

const competencyZod = z.object({
  key: z.string().min(1).max(60).regex(/^[a-z0-9_]+$/, 'key — латиница/цифры/подчёркивание'),
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
}).strict();

export const profileInputZod = z.object({
  orgDepartmentId: z.string().uuid(),
  positionId: z.string().uuid().nullable(),
  title: z.string().min(1).max(300),
  dutiesText: z.string().min(10).max(8000),
  competencies: z.array(competencyZod).min(1).max(15),
  isPublished: z.boolean(),
}).strict().superRefine((val, ctx) => {
  const keys = val.competencies.map(c => c.key);
  if (new Set(keys).size !== keys.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Ключи компетенций должны быть уникальны' });
  }
});

// ─── Сотрудник / доступность ─────────────────────────────────────────────────

interface IEmployeeContext {
  employeeId: number;
  departmentId: string | null;
  positionId: string | null;
  departmentName: string | null;
  positionName: string | null;
}

const loadEmployeeContext = async (employeeId: number): Promise<IEmployeeContext | null> => {
  const row = await queryOne<{
    id: number;
    org_department_id: string | null;
    position_id: string | null;
    department_name: string | null;
    position_name: string | null;
  }>(
    `SELECT e.id, e.org_department_id, e.position_id, d.name AS department_name, p.name AS position_name
       FROM employees e
       LEFT JOIN org_departments d ON d.id = e.org_department_id
       LEFT JOIN positions p ON p.id = e.position_id
      WHERE e.id = $1`,
    [employeeId],
  );
  if (!row) return null;
  return {
    employeeId: row.id,
    departmentId: row.org_department_id,
    positionId: row.position_id,
    departmentName: row.department_name,
    positionName: row.position_name,
  };
};

const countSessionsToday = async (employeeId: number): Promise<number> => {
  const row = await queryOne<{ cnt: number }>(
    `SELECT COUNT(*)::int AS cnt FROM adaptive_test_sessions
      WHERE employee_id = $1 AND started_at >= ${MSK_DAY_START_SQL}`,
    [employeeId],
  );
  return row?.cnt ?? 0;
};

const getActiveSession = async (employeeId: number): Promise<IAdaptiveSessionRow | null> =>
  queryOne<IAdaptiveSessionRow>(
    `SELECT * FROM adaptive_test_sessions WHERE employee_id = $1 AND status = 'in_progress'`,
    [employeeId],
  );

// ─── Диспетчеризация фоновых задач ───────────────────────────────────────────

const dispatchGeneration = (sessionId: string): void => {
  setImmediate(() => {
    void withLlmSlot(() => runGenerationStep(sessionId)).catch(err => {
      console.error(`[adaptive] generation dispatch error (${sessionId}):`, err);
    });
  });
};

const dispatchEvaluation = (questionId: string): void => {
  setImmediate(() => {
    void withLlmSlot(() => runEvaluationStep(questionId)).catch(err => {
      console.error(`[adaptive] evaluation dispatch error (${questionId}):`, err);
    });
  });
};

// ─── Генерация вопроса ───────────────────────────────────────────────────────

const isTestingEnabled = async (): Promise<boolean> => {
  const settings = await settingsService.getAdaptiveTestingSettings();
  return settings.enabled;
};

/**
 * Один шаг генерации: CAS-захват → выбор компетенции сервером → LLM →
 * token-guarded финализация (вопрос создаётся только в живой сессии).
 */
const runGenerationStep = async (sessionId: string): Promise<void> => {
  // Kill switch: при выключенной фиче новые LLM-вызовы не стартуют.
  if (!(await isTestingEnabled())) return;

  const token = randomUUID();
  const captured = await queryOne<IAdaptiveSessionRow>(
    `UPDATE adaptive_test_sessions s
        SET generation_state = 'generating',
            generation_token = $2,
            generation_started_at = now(),
            generation_lease_expires_at = now() + interval '${LEASE_MINUTES} minutes',
            generation_attempts = generation_attempts + 1
      WHERE s.id = $1
        AND s.status = 'in_progress'
        AND s.expires_at > now()
        AND s.generation_attempts < ${MAX_AUTO_ATTEMPTS}
        AND (
          s.generation_state = 'pending'
          OR (s.generation_state = 'generating' AND s.generation_lease_expires_at < now())
        )
        AND s.current_seq < s.total_questions
        AND (
          s.current_seq = 0
          OR EXISTS (
            SELECT 1 FROM adaptive_test_questions q
            JOIN adaptive_test_answers a ON a.question_id = q.id
            WHERE q.session_id = s.id AND q.seq = s.current_seq AND a.eval_state = 'evaluated'
          )
        )
      RETURNING s.*`,
    [sessionId, token],
  );

  if (!captured) {
    // Попытки исчерпаны в pending → failed (и терминальная ошибка, если
    // ручной retry уже израсходован).
    await execute(
      `UPDATE adaptive_test_sessions
          SET generation_state = 'failed',
              status = CASE WHEN manual_retry_count >= ${MAX_MANUAL_RETRIES} THEN 'error' ELSE status END
        WHERE id = $1 AND status = 'in_progress' AND generation_state = 'pending'
          AND generation_attempts >= ${MAX_AUTO_ATTEMPTS}`,
      [sessionId],
    );
    return;
  }

  try {
    const snapshot = captured.profile_snapshot;
    const asked = await query<{ competency_key: string; question_text: string; score: number | null; gap_tags: unknown }>(
      `SELECT q.competency_key, q.question_text, a.score, a.eval->'gap_tags' AS gap_tags
         FROM adaptive_test_questions q
         LEFT JOIN adaptive_test_answers a ON a.question_id = q.id
        WHERE q.session_id = $1
        ORDER BY q.seq`,
      [sessionId],
    );

    const spec = selectNextQuestion(
      snapshot.competencies,
      captured.competency_state ?? {},
      asked.map(r => ({ competencyKey: r.competency_key, score: r.score })),
      captured.current_seq + 1,
    );

    const gapTags = Array.from(new Set(
      asked.flatMap(r => (Array.isArray(r.gap_tags) ? (r.gap_tags as string[]) : [])),
    )).slice(0, 10);

    const generated = await adaptiveTestingLlmService.generateQuestion({
      sessionId,
      snapshot,
      competency: spec.competency,
      difficulty: spec.difficulty,
      type: spec.type,
      seq: spec.seq,
      askedQuestions: asked.map(r => r.question_text),
      gapTags,
    });

    // Финализация: только при живой сессии и нашем токене.
    await withTransaction(async client => {
      const updated = await client.query(
        `UPDATE adaptive_test_sessions
            SET generation_state = 'ready',
                generation_token = NULL,
                generation_lease_expires_at = NULL,
                generation_attempts = 0,
                generation_last_error = NULL,
                current_seq = current_seq + 1
          WHERE id = $1 AND generation_token = $2
            AND status = 'in_progress' AND expires_at > now()
          RETURNING current_seq`,
        [sessionId, token],
      );
      if (updated.rowCount === 0) return; // токен устарел/сессия закрыта — результат отброшен

      const seq = (updated.rows[0] as { current_seq: number }).current_seq;
      await client.query(
        `INSERT INTO adaptive_test_questions
           (session_id, seq, competency_key, difficulty, type, question_text, options, correct_option_ids, rubric)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          sessionId, seq, spec.competency.key, spec.difficulty, spec.type,
          generated.question_text,
          generated.options ? JSON.stringify(generated.options) : null,
          generated.correct_option_ids ? JSON.stringify(generated.correct_option_ids) : null,
          generated.rubric ? JSON.stringify(generated.rubric) : null,
        ],
      );
    });
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 500) : 'unknown';
    // Token-guarded catch: attempts < 2 → pending (авто-повтор), иначе failed.
    const row = await queryOne<{ generation_state: string }>(
      `UPDATE adaptive_test_sessions
          SET generation_state = CASE WHEN generation_attempts < ${MAX_AUTO_ATTEMPTS} THEN 'pending' ELSE 'failed' END,
              status = CASE
                WHEN generation_attempts >= ${MAX_AUTO_ATTEMPTS} AND manual_retry_count >= ${MAX_MANUAL_RETRIES} THEN 'error'
                ELSE status
              END,
              generation_token = NULL,
              generation_lease_expires_at = NULL,
              generation_last_error = $3
        WHERE id = $1 AND generation_token = $2 AND status = 'in_progress'
        RETURNING generation_state`,
      [sessionId, token, message],
    );
    Sentry.captureException(err, { tags: { service: 'adaptive-testing', stage: 'generate' } });
    // Немедленный авто-повтор второй попытки (не ждём sweeper).
    if (row?.generation_state === 'pending') dispatchGeneration(sessionId);
  }
};

// ─── Оценка ответа ───────────────────────────────────────────────────────────

interface ICapturedAnswer {
  id: string;
  question_id: string;
  answer: IAdaptiveAnswerPayload;
  session_id: string;
  seq: number;
  competency_key: string;
  difficulty: number;
  question_text: string;
  rubric: string[] | null;
  correct_option_ids: string[] | null;
  profile_snapshot: IAdaptiveProfileSnapshot;
}

const runEvaluationStep = async (questionId: string): Promise<void> => {
  if (!(await isTestingEnabled())) return;

  const token = randomUUID();
  const captured = await queryOne<ICapturedAnswer>(
    `UPDATE adaptive_test_answers a
        SET eval_state = 'evaluating',
            eval_token = $2,
            eval_started_at = now(),
            eval_lease_expires_at = now() + interval '${LEASE_MINUTES} minutes',
            eval_attempts = a.eval_attempts + 1
       FROM adaptive_test_questions q, adaptive_test_sessions s
      WHERE a.question_id = $1
        AND q.id = a.question_id AND s.id = q.session_id
        AND s.status = 'in_progress' AND s.expires_at > now()
        AND a.eval_attempts < ${MAX_AUTO_ATTEMPTS}
        AND (
          a.eval_state = 'pending'
          OR (a.eval_state = 'evaluating' AND a.eval_lease_expires_at < now())
        )
      RETURNING a.id, a.question_id, a.answer, q.session_id, q.seq, q.competency_key,
                q.difficulty, q.question_text, q.rubric, q.correct_option_ids, s.profile_snapshot`,
    [questionId, token],
  );

  if (!captured) {
    await execute(
      `UPDATE adaptive_test_answers a
          SET eval_state = 'failed'
         FROM adaptive_test_questions q, adaptive_test_sessions s
        WHERE a.question_id = $1 AND q.id = a.question_id AND s.id = q.session_id
          AND s.status = 'in_progress'
          AND a.eval_state = 'pending' AND a.eval_attempts >= ${MAX_AUTO_ATTEMPTS}`,
      [questionId],
    );
    await execute(
      `UPDATE adaptive_test_sessions s
          SET status = 'error'
         FROM adaptive_test_questions q, adaptive_test_answers a
        WHERE q.session_id = s.id AND a.question_id = q.id AND a.question_id = $1
          AND s.status = 'in_progress' AND a.eval_state = 'failed'
          AND s.manual_retry_count >= ${MAX_MANUAL_RETRIES}`,
      [questionId],
    );
    return;
  }

  try {
    if (captured.answer.type !== 'text') {
      // Закрытый ответ попал в пайплайн (crash до синхронной финализации) —
      // доводим сервером, LLM не нужна.
      const score = scoreClosedAnswer(captured.answer, captured.correct_option_ids ?? []);
      const res = await finalizeEvaluatedAnswer({ questionId, evalToken: token, score, evalJson: null });
      if (res.finalized && !res.sessionCompleted && res.sessionId) dispatchGeneration(res.sessionId);
      return;
    }
    const competency = captured.profile_snapshot.competencies.find(c => c.key === captured.competency_key)
      ?? { key: captured.competency_key, name: captured.competency_key };

    const evalResult = await adaptiveTestingLlmService.evaluateTextAnswer({
      sessionId: captured.session_id,
      snapshot: captured.profile_snapshot,
      competency,
      questionText: captured.question_text,
      rubric: captured.rubric ?? [],
      answerText: captured.answer.text,
    });

    const score = clamp(evalResult.rubric_score * 25, 0, 100);
    await finalizeEvaluatedAnswer({
      questionId,
      evalToken: token,
      score,
      evalJson: { matched: evalResult.matched, missed: evalResult.missed, gap_tags: evalResult.gap_tags },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 500) : 'unknown';
    const row = await queryOne<{ eval_state: string }>(
      `UPDATE adaptive_test_answers
          SET eval_state = CASE WHEN eval_attempts < ${MAX_AUTO_ATTEMPTS} THEN 'pending' ELSE 'failed' END,
              eval_token = NULL,
              eval_lease_expires_at = NULL,
              eval_last_error = $2
        WHERE question_id = $1 AND eval_token = $3
        RETURNING eval_state`,
      [questionId, message, token],
    );
    Sentry.captureException(err, { tags: { service: 'adaptive-testing', stage: 'evaluate' } });
    if (row?.eval_state === 'pending') dispatchEvaluation(questionId);
    if (row?.eval_state === 'failed') {
      await execute(
        `UPDATE adaptive_test_sessions s
            SET status = 'error'
           FROM adaptive_test_questions q
          WHERE q.session_id = s.id AND q.id = $1
            AND s.status = 'in_progress' AND s.manual_retry_count >= ${MAX_MANUAL_RETRIES}`,
        [questionId],
      );
    }
  }
};

/**
 * Успех оценки — ОДНА транзакция: answer → evaluated + competency_state +
 * (seq < 10 → generation pending; seq = 10 → завершение с итогом).
 * Всё token-guarded и только при живой сессии.
 */
const finalizeEvaluatedAnswer = async (params: {
  questionId: string;
  /** null — синхронная оценка закрытого ответа (токена нет). */
  evalToken: string | null;
  score: number;
  evalJson: { matched: string[]; missed: string[]; gap_tags: string[] } | null;
}): Promise<{ finalized: boolean; sessionCompleted: boolean; sessionId: string | null }> => {
  return withTransaction(async client => {
    const tokenCond = params.evalToken ? `AND a.eval_token = $4` : '';
    const answerParams: unknown[] = [params.questionId, params.score, params.evalJson ? JSON.stringify(params.evalJson) : null];
    if (params.evalToken) answerParams.push(params.evalToken);

    const answerRes = await client.query(
      `UPDATE adaptive_test_answers a
          SET eval_state = 'evaluated',
              eval_token = NULL,
              eval_lease_expires_at = NULL,
              eval_last_error = NULL,
              score = $2,
              eval = $3,
              evaluated_at = now()
         FROM adaptive_test_questions q, adaptive_test_sessions s
        WHERE a.question_id = $1 ${tokenCond}
          AND q.id = a.question_id AND s.id = q.session_id
          AND s.status = 'in_progress' AND s.expires_at > now()
          AND a.eval_state IN ('pending', 'evaluating')
        RETURNING q.session_id, q.seq, q.competency_key, q.difficulty`,
      answerParams,
    );
    if (answerRes.rowCount === 0) return { finalized: false, sessionCompleted: false, sessionId: null };

    const { session_id, seq, competency_key, difficulty } = answerRes.rows[0] as {
      session_id: string; seq: number; competency_key: string; difficulty: number;
    };

    const sessionRes = await client.query(
      `SELECT total_questions, competency_state, profile_snapshot
         FROM adaptive_test_sessions WHERE id = $1 FOR UPDATE`,
      [session_id],
    );
    const session = sessionRes.rows[0] as {
      total_questions: number;
      competency_state: Record<string, IAdaptiveCompetencyState>;
      profile_snapshot: IAdaptiveProfileSnapshot;
    };

    const state = { ...(session.competency_state ?? {}) };
    const prev = state[competency_key] ?? { askedCount: 0, scoreSum: 0, lastScore: null, nextDifficulty: 1, consecutive: 0 };
    state[competency_key] = {
      askedCount: prev.askedCount + 1,
      scoreSum: prev.scoreSum + params.score,
      lastScore: params.score,
      nextDifficulty: adjustDifficulty(difficulty, params.score),
      consecutive: prev.consecutive,
    };

    const isLast = seq >= session.total_questions;
    if (isLast) {
      const summary = computeResultSummary(session.profile_snapshot.competencies, state);
      await client.query(
        `UPDATE adaptive_test_sessions
            SET competency_state = $2,
                status = 'completed',
                completed_at = now(),
                overall_score = $3,
                coverage_pct = $4,
                strengths = $5,
                weaknesses = $6,
                recommendations = $7
          WHERE id = $1`,
        [
          session_id, JSON.stringify(state),
          summary.overallScore, summary.coveragePct,
          JSON.stringify(summary.strengths), JSON.stringify(summary.weaknesses),
          JSON.stringify(summary.recommendations),
        ],
      );
      return { finalized: true, sessionCompleted: true, sessionId: session_id };
    }

    await client.query(
      `UPDATE adaptive_test_sessions
          SET competency_state = $2, generation_state = 'pending'
        WHERE id = $1`,
      [session_id, JSON.stringify(state)],
    );
    return { finalized: true, sessionCompleted: false, sessionId: session_id };
  });
};

// ─── Публичное API сервиса ───────────────────────────────────────────────────

export const adaptiveTestingService = {
  async getAvailability(userEmail: string | null, employeeId: number | null): Promise<IAdaptiveAvailability> {
    const settings = await settingsService.getAdaptiveTestingSettings();

    const active = employeeId ? await getActiveSession(employeeId) : null;
    const base: IAdaptiveAvailability = {
      available: false,
      reason: null,
      activeSessionId: active?.id ?? null,
      canStartNew: false,
    };

    if (!settings.enabled) return { ...base, reason: 'disabled' };
    if (!employeeId) return { ...base, reason: 'no_employee' };
    if (!isEmailAllowed(settings.allowedEmails, userEmail)) return { ...base, reason: 'not_allowed' };

    const ctx = await loadEmployeeContext(employeeId);
    if (!ctx || !ctx.departmentId) return { ...base, reason: 'no_profile' };
    const profile = await findPublishedProfile(ctx.departmentId, ctx.positionId);
    if (!profile) return { ...base, reason: 'no_profile' };

    const usedToday = await countSessionsToday(employeeId);
    const canStartNew = !active && usedToday < settings.dailySessionsLimit;

    return {
      available: Boolean(active) || canStartNew,
      reason: 'ok',
      activeSessionId: active?.id ?? null,
      canStartNew,
    };
  },

  /** Идемпотентный старт: активная сессия возвращается ДО проверки дневного лимита. */
  async startSession(userEmail: string | null, employeeId: number, userId: string): Promise<{ sessionId: string; resumed: boolean }> {
    const settings = await settingsService.getAdaptiveTestingSettings();
    if (!settings.enabled) throw Object.assign(new Error('Тестирование выключено'), { httpStatus: 409, code: 'disabled' });
    if (!isEmailAllowed(settings.allowedEmails, userEmail)) {
      throw Object.assign(new Error('Тестирование недоступно'), { httpStatus: 403, code: 'not_allowed' });
    }

    // Просроченная активная — финализируется перед созданием новой.
    await execute(
      `UPDATE adaptive_test_sessions SET status = 'cancelled'
        WHERE employee_id = $1 AND status = 'in_progress' AND expires_at <= now()`,
      [employeeId],
    );

    const existing = await getActiveSession(employeeId);
    if (existing) return { sessionId: existing.id, resumed: true };

    const usedToday = await countSessionsToday(employeeId);
    if (usedToday >= settings.dailySessionsLimit) {
      throw Object.assign(new Error('Дневной лимит тестирований исчерпан'), { httpStatus: 429, code: 'daily_limit' });
    }

    const ctx = await loadEmployeeContext(employeeId);
    if (!ctx || !ctx.departmentId) {
      throw Object.assign(new Error('Не определён отдел сотрудника'), { httpStatus: 409, code: 'no_profile' });
    }
    const profile = await findPublishedProfile(ctx.departmentId, ctx.positionId);
    if (!profile) {
      throw Object.assign(new Error('Для вашей должности не настроен профиль тестирования'), { httpStatus: 409, code: 'no_profile' });
    }

    const snapshot: IAdaptiveProfileSnapshot = {
      profileId: profile.id,
      title: profile.title,
      departmentName: ctx.departmentName ?? '',
      positionName: ctx.positionName,
      dutiesText: profile.duties_text,
      competencies: profile.competencies,
    };

    const config = await settingsService.getResolvedAdaptiveLlmConfig();
    if (!config.ok) {
      throw Object.assign(new Error(`Подключение LLM не настроено (${config.reason})`), { httpStatus: 503, code: 'invalid_llm_config' });
    }

    let sessionId: string;
    try {
      const row = await queryOne<{ id: string }>(
        `INSERT INTO adaptive_test_sessions
           (employee_id, user_id, skill_profile_id, profile_snapshot, department_id_snapshot,
            position_id_snapshot, model, prompt_version, total_questions, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + interval '${SESSION_TTL_HOURS} hours')
         RETURNING id`,
        [
          employeeId, userId, profile.id, JSON.stringify(snapshot),
          ctx.departmentId, ctx.positionId, config.model, ADAPTIVE_PROMPT_VERSION, TOTAL_QUESTIONS,
        ],
      );
      sessionId = row!.id;
    } catch (err) {
      // Конкурентный старт: partial-unique нарушен → вернуть уже созданную.
      const pgErr = err as { code?: string };
      if (pgErr.code === '23505') {
        const active = await getActiveSession(employeeId);
        if (active) return { sessionId: active.id, resumed: true };
      }
      throw err;
    }

    dispatchGeneration(sessionId);
    return { sessionId, resumed: false };
  },

  /**
   * Текущее состояние для поллинга. Поллинг НЕ перезапускает LLM —
   * подхват зависшего делает sweeper.
   */
  async getCurrentSession(employeeId: number): Promise<{
    state: AdaptiveCurrentState | 'none';
    sessionId: string | null;
    seq: number;
    totalQuestions: number;
    question: {
      id: string;
      seq: number;
      type: AdaptiveQuestionType;
      questionText: string;
      options: IAdaptiveQuestionOption[] | null;
    } | null;
    result: IResultSummaryDto | null;
    canStartNew: boolean;
    lastErrorSessionId: string | null;
    errorMessage: string | null;
  }> {
    const settings = await settingsService.getAdaptiveTestingSettings();

    const active = await getActiveSession(employeeId);
    if (active) {
      if (!settings.enabled) {
        return emptyCurrent('paused', active);
      }
      if (active.generation_state === 'failed') {
        return { ...emptyCurrent('failed', active), errorMessage: 'Не удалось подготовить вопрос. Нажмите «Повторить».' };
      }
      if (active.generation_state === 'pending' || active.generation_state === 'generating') {
        return emptyCurrent('generating', active);
      }
      // ready: текущий вопрос показан — есть ли по нему ответ в обработке?
      const q = await queryOne<IAdaptiveQuestionRow & { eval_state: string | null }>(
        `SELECT q.*, a.eval_state
           FROM adaptive_test_questions q
           LEFT JOIN adaptive_test_answers a ON a.question_id = q.id
          WHERE q.session_id = $1 AND q.seq = $2`,
        [active.id, active.current_seq],
      );
      if (!q) return emptyCurrent('generating', active);
      if (q.eval_state === 'pending' || q.eval_state === 'evaluating') {
        return emptyCurrent('evaluating', active);
      }
      if (q.eval_state === 'failed') {
        return { ...emptyCurrent('failed', active), errorMessage: 'Не удалось оценить ответ. Нажмите «Повторить».' };
      }
      return {
        ...emptyCurrent('question_ready', active),
        question: {
          id: q.id,
          seq: q.seq,
          type: q.type,
          questionText: q.question_text,
          // Правильные ответы и рубрика фронту не отдаются до завершения.
          options: q.options,
        },
      };
    }

    // Активной нет: последняя сессия текущих суток (МСК).
    const latest = await queryOne<IAdaptiveSessionRow>(
      `SELECT * FROM adaptive_test_sessions
        WHERE employee_id = $1 AND started_at >= ${MSK_DAY_START_SQL}
        ORDER BY started_at DESC LIMIT 1`,
      [employeeId],
    );
    const usedToday = await countSessionsToday(employeeId);
    const canStartNew = usedToday < settings.dailySessionsLimit;

    if (latest?.status === 'completed') {
      return {
        state: 'completed', sessionId: latest.id, seq: latest.current_seq,
        totalQuestions: latest.total_questions, question: null,
        result: buildResultSummary(latest), canStartNew,
        lastErrorSessionId: null, errorMessage: null,
      };
    }
    if (latest?.status === 'error') {
      // Терминальная ошибка «залипает» в current только при исчерпанном лимите.
      if (!canStartNew) {
        return {
          state: 'error', sessionId: latest.id, seq: latest.current_seq,
          totalQuestions: latest.total_questions, question: null, result: null,
          canStartNew: false, lastErrorSessionId: latest.id,
          errorMessage: 'Тест прерван из-за технической ошибки. Попробуйте в другой день.',
        };
      }
      return { state: 'none', sessionId: null, seq: 0, totalQuestions: TOTAL_QUESTIONS, question: null, result: null, canStartNew, lastErrorSessionId: latest.id, errorMessage: null };
    }

    return { state: 'none', sessionId: null, seq: 0, totalQuestions: TOTAL_QUESTIONS, question: null, result: null, canStartNew, lastErrorSessionId: null, errorMessage: null };
  },

  /**
   * Приём ответа: только владелец, только на текущий вопрос. Повтор
   * идентичного payload идемпотентен; другой ответ на отвеченный → 409.
   */
  async submitAnswer(employeeId: number, sessionId: string, questionId: string, rawAnswer: unknown): Promise<{ accepted: boolean }> {
    const settings = await settingsService.getAdaptiveTestingSettings();
    if (!settings.enabled) throw Object.assign(new Error('Тестирование приостановлено'), { httpStatus: 409, code: 'paused' });

    const session = await queryOne<IAdaptiveSessionRow>(
      `SELECT * FROM adaptive_test_sessions
        WHERE id = $1 AND employee_id = $2 AND status = 'in_progress' AND expires_at > now()`,
      [sessionId, employeeId],
    );
    if (!session) throw Object.assign(new Error('Активная сессия не найдена'), { httpStatus: 404 });

    const question = await queryOne<IAdaptiveQuestionRow>(
      `SELECT * FROM adaptive_test_questions WHERE id = $1 AND session_id = $2`,
      [questionId, sessionId],
    );
    if (!question) throw Object.assign(new Error('Вопрос не найден'), { httpStatus: 404 });
    // Ответ принимается только на текущий вопрос.
    if (question.seq !== session.current_seq || session.generation_state !== 'ready') {
      throw Object.assign(new Error('Ответ не на текущий вопрос'), { httpStatus: 409, code: 'not_current_question' });
    }

    const payload = validateAnswerPayload(rawAnswer, question.type, question.options);
    if (payload.type !== question.type) {
      throw Object.assign(new Error('Тип ответа не совпадает с типом вопроса'), { httpStatus: 400 });
    }

    const inserted = await queryOne<{ id: string }>(
      `INSERT INTO adaptive_test_answers (question_id, answer)
       VALUES ($1, $2)
       ON CONFLICT (question_id) DO NOTHING
       RETURNING id`,
      [questionId, JSON.stringify(payload)],
    );

    if (!inserted) {
      // Уже есть ответ: идентичный payload → идемпотентно, иной → 409.
      const existing = await queryOne<{ answer: IAdaptiveAnswerPayload }>(
        `SELECT answer FROM adaptive_test_answers WHERE question_id = $1`,
        [questionId],
      );
      if (existing && JSON.stringify(existing.answer) === JSON.stringify(payload)) {
        return { accepted: true };
      }
      throw Object.assign(new Error('На этот вопрос уже дан другой ответ'), { httpStatus: 409, code: 'already_answered' });
    }

    if (payload.type === 'text') {
      dispatchEvaluation(questionId);
    } else {
      // Закрытые типы: оценка синхронно сервером, транзакция та же, что у LLM-пути.
      const score = scoreClosedAnswer(payload, question.correct_option_ids ?? []);
      const res = await finalizeEvaluatedAnswer({ questionId, evalToken: null, score, evalJson: null });
      if (res.finalized && !res.sessionCompleted && res.sessionId) {
        dispatchGeneration(res.sessionId);
      }
    }

    return { accepted: true };
  },

  /** Ручной retry: одна транзакция, лимит MAX_MANUAL_RETRIES, сброс только упавшего этапа. */
  async retrySession(employeeId: number): Promise<{ stage: 'generation' | 'evaluation' }> {
    if (!(await isTestingEnabled())) {
      throw Object.assign(new Error('Тестирование приостановлено'), { httpStatus: 409, code: 'paused' });
    }

    const result = await withTransaction(async client => {
      const sessionRes = await client.query(
        `SELECT id, generation_state, manual_retry_count, current_seq FROM adaptive_test_sessions
          WHERE employee_id = $1 AND status = 'in_progress' AND expires_at > now()
          FOR UPDATE`,
        [employeeId],
      );
      const session = sessionRes.rows[0] as
        | { id: string; generation_state: string; manual_retry_count: number; current_seq: number }
        | undefined;
      if (!session) throw Object.assign(new Error('Активная сессия не найдена'), { httpStatus: 404 });
      if (session.manual_retry_count >= MAX_MANUAL_RETRIES) {
        throw Object.assign(new Error('Лимит повторов исчерпан'), { httpStatus: 409, code: 'retry_limit' });
      }

      if (session.generation_state === 'failed') {
        await client.query(
          `UPDATE adaptive_test_sessions
              SET generation_state = 'pending', generation_token = NULL,
                  generation_lease_expires_at = NULL, generation_last_error = NULL,
                  generation_attempts = 0, manual_retry_count = manual_retry_count + 1
            WHERE id = $1`,
          [session.id],
        );
        return { stage: 'generation' as const, sessionId: session.id, questionId: null };
      }

      const answerRes = await client.query(
        `SELECT a.question_id FROM adaptive_test_answers a
           JOIN adaptive_test_questions q ON q.id = a.question_id
          WHERE q.session_id = $1 AND q.seq = $2 AND a.eval_state = 'failed'`,
        [session.id, session.current_seq],
      );
      const failedAnswer = answerRes.rows[0] as { question_id: string } | undefined;
      if (!failedAnswer) {
        throw Object.assign(new Error('Нет упавшего этапа для повтора'), { httpStatus: 409, code: 'nothing_to_retry' });
      }

      await client.query(
        `UPDATE adaptive_test_answers
            SET eval_state = 'pending', eval_token = NULL,
                eval_lease_expires_at = NULL, eval_last_error = NULL, eval_attempts = 0
          WHERE question_id = $1`,
        [failedAnswer.question_id],
      );
      await client.query(
        `UPDATE adaptive_test_sessions SET manual_retry_count = manual_retry_count + 1 WHERE id = $1`,
        [session.id],
      );
      return { stage: 'evaluation' as const, sessionId: session.id, questionId: failedAnswer.question_id };
    });

    if (result.stage === 'generation') dispatchGeneration(result.sessionId);
    else if (result.questionId) dispatchEvaluation(result.questionId);
    return { stage: result.stage };
  },

  async cancelSession(employeeId: number): Promise<void> {
    const updated = await execute(
      `UPDATE adaptive_test_sessions SET status = 'cancelled'
        WHERE employee_id = $1 AND status = 'in_progress'`,
      [employeeId],
    );
    if (updated === 0) throw Object.assign(new Error('Активная сессия не найдена'), { httpStatus: 404 });
  },

  // ─── Результаты ───

  async listResultsForEmployee(employeeId: number, limit: number, offset: number): Promise<IResultListItem[]> {
    return listResults({ employeeIds: [employeeId], limit, offset });
  },

  async listResultsScoped(employeeIds: Set<number> | 'all', limit: number, offset: number): Promise<IResultListItem[]> {
    if (employeeIds !== 'all' && employeeIds.size === 0) return [];
    return listResults({ employeeIds: employeeIds === 'all' ? 'all' : Array.from(employeeIds), limit, offset });
  },

  /**
   * Деталь результата. includeAnswers=false — руководительский вид: итог и
   * разбивка по компетенциям, без текстов вопросов/ответов.
   */
  async getResultDetail(sessionId: string, includeAnswers: boolean): Promise<IResultDetail | null> {
    const session = await queryOne<IAdaptiveSessionRow & { employee_name: string | null }>(
      `SELECT s.*, e.full_name AS employee_name
         FROM adaptive_test_sessions s
         LEFT JOIN employees e ON e.id = s.employee_id
        WHERE s.id = $1`,
      [sessionId],
    );
    if (!session) return null;

    const detail: IResultDetail = {
      sessionId: session.id,
      employeeId: session.employee_id,
      employeeName: session.employee_name,
      departmentName: session.profile_snapshot?.departmentName ?? null,
      positionName: session.profile_snapshot?.positionName ?? null,
      status: session.status,
      startedAt: session.started_at,
      completedAt: session.completed_at,
      result: buildResultSummary(session),
      competencies: buildCompetencyBreakdown(session),
      answers: null,
    };

    if (includeAnswers) {
      const completed = session.status === 'completed';
      const rows = await query<{
        seq: number; competency_key: string; difficulty: number; type: AdaptiveQuestionType;
        question_text: string; options: IAdaptiveQuestionOption[] | null;
        correct_option_ids: string[] | null;
        answer: IAdaptiveAnswerPayload | null; score: number | null;
        eval: { matched: string[]; missed: string[]; gap_tags: string[] } | null;
      }>(
        `SELECT q.seq, q.competency_key, q.difficulty, q.type, q.question_text, q.options,
                q.correct_option_ids, a.answer, a.score, a.eval
           FROM adaptive_test_questions q
           LEFT JOIN adaptive_test_answers a ON a.question_id = q.id
          WHERE q.session_id = $1
          ORDER BY q.seq`,
        [sessionId],
      );
      detail.answers = rows.map(r => ({
        seq: r.seq,
        competencyKey: r.competency_key,
        difficulty: r.difficulty,
        type: r.type,
        questionText: r.question_text,
        options: r.options,
        // Правильные ответы — только по завершённой сессии.
        correctOptionIds: completed ? r.correct_option_ids : null,
        answer: r.answer,
        score: r.score,
        eval: r.eval,
      }));
    }

    return detail;
  },

  // ─── Skill-профили ───

  async listProfiles(): Promise<IProfileListItem[]> {
    return query<IProfileListItem>(
      `SELECT sp.id, sp.org_department_id AS "orgDepartmentId", d.name AS "departmentName",
              sp.position_id AS "positionId", p.name AS "positionName",
              sp.title, sp.duties_text AS "dutiesText", sp.competencies,
              sp.is_published AS "isPublished", sp.updated_at AS "updatedAt"
         FROM adaptive_skill_profiles sp
         LEFT JOIN org_departments d ON d.id = sp.org_department_id
         LEFT JOIN positions p ON p.id = sp.position_id
        ORDER BY d.name NULLS LAST, p.name NULLS FIRST`,
    );
  },

  async saveProfile(rawInput: unknown, userId: string, profileId?: string): Promise<{ id: string }> {
    const input = profileInputZod.parse(rawInput);

    if (profileId) {
      const updated = await queryOne<{ id: string }>(
        `UPDATE adaptive_skill_profiles
            SET org_department_id = $2, position_id = $3, title = $4, duties_text = $5,
                competencies = $6, is_published = $7, updated_at = now()
          WHERE id = $1
          RETURNING id`,
        [
          profileId, input.orgDepartmentId, input.positionId, input.title,
          input.dutiesText, JSON.stringify(input.competencies), input.isPublished,
        ],
      );
      if (!updated) throw Object.assign(new Error('Профиль не найден'), { httpStatus: 404 });
      return updated;
    }

    const created = await queryOne<{ id: string }>(
      `INSERT INTO adaptive_skill_profiles
         (org_department_id, position_id, title, duties_text, competencies, is_published, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        input.orgDepartmentId, input.positionId, input.title, input.dutiesText,
        JSON.stringify(input.competencies), input.isPublished, userId,
      ],
    );
    return created!;
  },

  /** Отчёт покрытия: отдел×должность активных сотрудников → статус профиля. */
  async getCoverageReport(): Promise<ICoverageRow[]> {
    return query<ICoverageRow>(
      `SELECT e.org_department_id AS "departmentId", d.name AS "departmentName",
              e.position_id AS "positionId", p.name AS "positionName",
              COUNT(*)::int AS "employees",
              EXISTS (
                SELECT 1 FROM adaptive_skill_profiles sp
                 WHERE sp.org_department_id = e.org_department_id
                   AND sp.position_id = e.position_id AND sp.is_published
              ) AS "hasExactProfile",
              EXISTS (
                SELECT 1 FROM adaptive_skill_profiles sp
                 WHERE sp.org_department_id = e.org_department_id
                   AND sp.position_id IS NULL AND sp.is_published
              ) AS "hasDepartmentProfile"
         FROM employees e
         LEFT JOIN org_departments d ON d.id = e.org_department_id
         LEFT JOIN positions p ON p.id = e.position_id
        WHERE e.employment_status = 'active' AND e.is_archived = false
          AND e.org_department_id IS NOT NULL
        GROUP BY e.org_department_id, d.name, e.position_id, p.name
        ORDER BY d.name, p.name NULLS FIRST`,
    );
  },

  // ─── Фоновое обслуживание ───

  /**
   * Resume при старте сервера: подхватывает только pending-работу и
   * просроченные lease. Живые lease НЕ трогает (rolling deploy — прежний
   * экземпляр может ещё выполнять вызов).
   */
  async resumePendingAdaptiveTests(): Promise<void> {
    try {
      await this.sweep();
      console.log('[adaptive] resumePendingAdaptiveTests: sweep выполнен');
    } catch (err) {
      console.error('[adaptive] resume error:', err);
    }
  },

  /**
   * Sweeper (интервал ~45с): финализирует просроченные сессии, подбирает
   * pending/просроченные lease. Batch limit — без всплеска запросов к прокси.
   */
  async sweep(): Promise<void> {
    // Просроченные сессии → cancelled.
    await execute(
      `UPDATE adaptive_test_sessions SET status = 'cancelled'
        WHERE status = 'in_progress' AND expires_at <= now()`,
    );

    if (!(await isTestingEnabled())) return;

    const sessions = await query<{ id: string }>(
      `SELECT id FROM adaptive_test_sessions
        WHERE status = 'in_progress' AND expires_at > now()
          AND generation_attempts < ${MAX_AUTO_ATTEMPTS}
          AND (
            generation_state = 'pending'
            OR (generation_state = 'generating' AND generation_lease_expires_at < now())
          )
        ORDER BY started_at
        LIMIT ${SWEEP_BATCH_LIMIT}`,
    );
    for (const s of sessions) dispatchGeneration(s.id);

    const answers = await query<{ question_id: string }>(
      `SELECT a.question_id
         FROM adaptive_test_answers a
         JOIN adaptive_test_questions q ON q.id = a.question_id
         JOIN adaptive_test_sessions s ON s.id = q.session_id
        WHERE s.status = 'in_progress' AND s.expires_at > now()
          AND a.eval_attempts < ${MAX_AUTO_ATTEMPTS}
          AND (
            a.eval_state = 'pending'
            OR (a.eval_state = 'evaluating' AND a.eval_lease_expires_at < now())
          )
        ORDER BY a.answered_at
        LIMIT ${SWEEP_BATCH_LIMIT}`,
    );
    for (const a of answers) dispatchEvaluation(a.question_id);
  },

  startSweeper(): NodeJS.Timeout {
    const timer = setInterval(() => {
      void this.sweep().catch(err => console.error('[adaptive] sweep error:', err));
    }, SWEEP_INTERVAL_MS);
    timer.unref();
    return timer;
  },
};

// ─── DTO-хелперы ─────────────────────────────────────────────────────────────

export interface IResultSummaryDto {
  overallScore: number | null;
  coveragePct: number | null;
  strengths: string[];
  weaknesses: string[];
  recommendations: string[];
}

export interface IResultListItem {
  sessionId: string;
  employeeId: number;
  employeeName: string | null;
  departmentName: string | null;
  positionName: string | null;
  status: string;
  overallScore: number | null;
  coveragePct: number | null;
  weaknesses: string[] | null;
  startedAt: string;
  completedAt: string | null;
}

export interface IResultDetail {
  sessionId: string;
  employeeId: number;
  employeeName: string | null;
  departmentName: string | null;
  positionName: string | null;
  status: string;
  startedAt: string;
  completedAt: string | null;
  result: IResultSummaryDto | null;
  competencies: { key: string; name: string; askedCount: number; avgScore: number }[];
  answers:
    | {
        seq: number;
        competencyKey: string;
        difficulty: number;
        type: AdaptiveQuestionType;
        questionText: string;
        options: IAdaptiveQuestionOption[] | null;
        correctOptionIds: string[] | null;
        answer: IAdaptiveAnswerPayload | null;
        score: number | null;
        eval: { matched: string[]; missed: string[]; gap_tags: string[] } | null;
      }[]
    | null;
}

export interface IProfileListItem {
  id: string;
  orgDepartmentId: string;
  departmentName: string | null;
  positionId: string | null;
  positionName: string | null;
  title: string;
  dutiesText: string;
  competencies: IAdaptiveCompetency[];
  isPublished: boolean;
  updatedAt: string;
}

export interface ICoverageRow {
  departmentId: string;
  departmentName: string | null;
  positionId: string | null;
  positionName: string | null;
  employees: number;
  hasExactProfile: boolean;
  hasDepartmentProfile: boolean;
}

const emptyCurrent = (
  state: AdaptiveCurrentState,
  session: IAdaptiveSessionRow,
): {
  state: AdaptiveCurrentState;
  sessionId: string;
  seq: number;
  totalQuestions: number;
  question: null;
  result: null;
  canStartNew: boolean;
  lastErrorSessionId: null;
  errorMessage: null;
} => ({
  state,
  sessionId: session.id,
  seq: session.current_seq,
  totalQuestions: session.total_questions,
  question: null,
  result: null,
  canStartNew: false,
  lastErrorSessionId: null,
  errorMessage: null,
});

const buildResultSummary = (session: IAdaptiveSessionRow): IResultSummaryDto | null => {
  if (session.status !== 'completed') return null;
  return {
    overallScore: session.overall_score,
    coveragePct: session.coverage_pct,
    strengths: session.strengths ?? [],
    weaknesses: session.weaknesses ?? [],
    recommendations: session.recommendations ?? [],
  };
};

const buildCompetencyBreakdown = (
  session: IAdaptiveSessionRow,
): { key: string; name: string; askedCount: number; avgScore: number }[] => {
  const competencies = session.profile_snapshot?.competencies ?? [];
  const state = session.competency_state ?? {};
  return competencies.map(c => {
    const st = state[c.key];
    const asked = st?.askedCount ?? 0;
    return {
      key: c.key,
      name: c.name,
      askedCount: asked,
      avgScore: asked > 0 && st ? Math.round(st.scoreSum / asked) : 0,
    };
  });
};

const listResults = async (params: {
  employeeIds: number[] | 'all';
  limit: number;
  offset: number;
}): Promise<IResultListItem[]> => {
  const limit = clamp(Math.floor(params.limit) || 25, 1, 100);
  const offset = Math.max(0, Math.floor(params.offset) || 0);

  const scopeCond = params.employeeIds === 'all' ? '' : 'AND s.employee_id = ANY($3::int[])';
  const sqlParams: unknown[] = [limit, offset];
  if (params.employeeIds !== 'all') sqlParams.push(params.employeeIds);

  return query<IResultListItem>(
    `SELECT s.id AS "sessionId", s.employee_id AS "employeeId", e.full_name AS "employeeName",
            s.profile_snapshot->>'departmentName' AS "departmentName",
            s.profile_snapshot->>'positionName' AS "positionName",
            s.status, s.overall_score AS "overallScore", s.coverage_pct AS "coveragePct",
            s.weaknesses, s.started_at AS "startedAt", s.completed_at AS "completedAt"
       FROM adaptive_test_sessions s
       LEFT JOIN employees e ON e.id = s.employee_id
      WHERE s.status IN ('completed', 'error') ${scopeCond}
      ORDER BY s.started_at DESC
      LIMIT $1 OFFSET $2`,
    sqlParams,
  );
};
