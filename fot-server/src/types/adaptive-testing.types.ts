// Типы адаптивного тестирования (LLM через OpenRouter-прокси).

export type AdaptiveQuestionType = 'single' | 'multiple' | 'text';

export type AdaptiveSessionStatus = 'in_progress' | 'completed' | 'cancelled' | 'error';

export type AdaptiveGenerationState = 'pending' | 'generating' | 'ready' | 'failed';

export type AdaptiveEvalState = 'pending' | 'evaluating' | 'evaluated' | 'failed';

export interface IAdaptiveCompetency {
  key: string;
  name: string;
  description?: string;
}

/** Снапшот профиля на момент старта сессии — живёт в profile_snapshot. */
export interface IAdaptiveProfileSnapshot {
  profileId: string | null;
  title: string;
  departmentName: string;
  positionName: string | null;
  dutiesText: string;
  competencies: IAdaptiveCompetency[];
  /** Содержимое загруженного .md со скиллом отдела (если админ его прикрепил). */
  skillMd?: string | null;
  skillMdFilename?: string | null;
}

/** Состояние компетенции внутри сессии (competency_state JSONB, по key). */
export interface IAdaptiveCompetencyState {
  askedCount: number;
  scoreSum: number;
  lastScore: number | null;
  /** Сложность следующего вопроса этой компетенции (1..3). */
  nextDifficulty: number;
  /** Сколько вопросов подряд задано по этой компетенции (лимит 2). */
  consecutive: number;
}

export interface IAdaptiveQuestionOption {
  id: string;
  text: string;
}

/** Валидированный результат генератора вопросов (без competency/difficulty/seq — их задаёт сервер). */
export interface IAdaptiveGeneratedQuestion {
  question_text: string;
  options: IAdaptiveQuestionOption[] | null;
  correct_option_ids: string[] | null;
  rubric: string[] | null;
}

/** Валидированный результат оценщика текстового ответа. */
export interface IAdaptiveEvalResult {
  /** Рубрика 0–4 (переводится в 0–100 умножением на 25). */
  rubric_score: number;
  matched: string[];
  missed: string[];
  gap_tags: string[];
}

export interface IAdaptiveSessionRow {
  id: string;
  employee_id: number;
  user_id: string | null;
  skill_profile_id: string | null;
  profile_snapshot: IAdaptiveProfileSnapshot;
  department_id_snapshot: string | null;
  position_id_snapshot: string | null;
  model: string;
  prompt_version: string;
  status: AdaptiveSessionStatus;
  generation_state: AdaptiveGenerationState;
  generation_token: string | null;
  generation_attempts: number;
  generation_last_error: string | null;
  manual_retry_count: number;
  total_questions: number;
  current_seq: number;
  competency_state: Record<string, IAdaptiveCompetencyState>;
  overall_score: number | null;
  coverage_pct: number | null;
  strengths: string[] | null;
  weaknesses: string[] | null;
  recommendations: string[] | null;
  started_at: string;
  completed_at: string | null;
  expires_at: string;
}

export interface IAdaptiveQuestionRow {
  id: string;
  session_id: string;
  seq: number;
  competency_key: string;
  difficulty: number;
  type: AdaptiveQuestionType;
  question_text: string;
  options: IAdaptiveQuestionOption[] | null;
  correct_option_ids: string[] | null;
  rubric: string[] | null;
  created_at: string;
}

export interface IAdaptiveAnswerRow {
  id: string;
  question_id: string;
  answer: IAdaptiveAnswerPayload;
  eval_state: AdaptiveEvalState;
  eval_attempts: number;
  eval_last_error: string | null;
  score: number | null;
  eval: { matched: string[]; missed: string[]; gap_tags: string[] } | null;
  answered_at: string;
  evaluated_at: string | null;
}

/** Ответ сотрудника (строгая валидация в сервисе). */
export type IAdaptiveAnswerPayload =
  | { type: 'single'; optionId: string }
  | { type: 'multiple'; optionIds: string[] }
  | { type: 'text'; text: string };

export type AdaptiveCurrentState =
  | 'generating'
  | 'evaluating'
  | 'question_ready'
  | 'failed'
  | 'error'
  | 'paused'
  | 'completed';

export interface IAdaptiveAvailability {
  available: boolean;
  reason: 'ok' | 'disabled' | 'not_allowed' | 'no_employee' | 'no_profile' | 'no_page_access' | null;
  activeSessionId: string | null;
  canStartNew: boolean;
}
