import { apiClient } from '../api/client';

interface ApiResponse<T> {
  data: T;
  success?: boolean;
}

export type AdaptiveQuestionType = 'single' | 'multiple' | 'text';

export type AdaptiveCurrentState =
  | 'none'
  | 'generating'
  | 'evaluating'
  | 'question_ready'
  | 'failed'
  | 'error'
  | 'paused'
  | 'completed';

export interface IAdaptiveAvailability {
  available: boolean;
  reason: 'ok' | 'disabled' | 'not_allowed' | 'no_employee' | 'no_profile' | null;
  activeSessionId: string | null;
  canStartNew: boolean;
}

export interface IAdaptiveQuestionDto {
  id: string;
  seq: number;
  type: AdaptiveQuestionType;
  questionText: string;
  options: { id: string; text: string }[] | null;
}

export interface IAdaptiveResultSummary {
  overallScore: number | null;
  coveragePct: number | null;
  strengths: string[];
  weaknesses: string[];
  recommendations: string[];
}

export interface IAdaptiveCurrent {
  state: AdaptiveCurrentState;
  sessionId: string | null;
  seq: number;
  totalQuestions: number;
  question: IAdaptiveQuestionDto | null;
  result: IAdaptiveResultSummary | null;
  canStartNew: boolean;
  lastErrorSessionId: string | null;
  errorMessage: string | null;
}

export type IAdaptiveAnswerInput =
  | { type: 'single'; optionId: string }
  | { type: 'multiple'; optionIds: string[] }
  | { type: 'text'; text: string };

/** Разбор отвеченного вопроса. Для text правильного варианта нет — только рубрика. */
export interface IAdaptiveReveal {
  seq: number;
  type: AdaptiveQuestionType;
  questionText: string;
  options: { id: string; text: string }[] | null;
  correctOptionIds: string[] | null;
  rubric: string[] | null;
  answer: IAdaptiveAnswerInput;
  score: number | null;
  evalState: string;
}

export interface IAdaptiveResultListItem {
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

export interface IAdaptiveResultDetail {
  sessionId: string;
  employeeId: number;
  employeeName: string | null;
  departmentName: string | null;
  positionName: string | null;
  status: string;
  startedAt: string;
  completedAt: string | null;
  result: IAdaptiveResultSummary | null;
  competencies: { key: string; name: string; askedCount: number; avgScore: number }[];
  answers:
    | {
        seq: number;
        competencyKey: string;
        difficulty: number;
        type: AdaptiveQuestionType;
        questionText: string;
        options: { id: string; text: string }[] | null;
        correctOptionIds: string[] | null;
        answer: IAdaptiveAnswerInput | null;
        score: number | null;
        eval: { matched: string[]; missed: string[]; gap_tags: string[] } | null;
      }[]
    | null;
}

export interface IAdaptiveCompetencyInput {
  key: string;
  name: string;
  description?: string;
}

export interface IAdaptiveProfile {
  id: string;
  orgDepartmentId: string;
  departmentName: string | null;
  positionId: string | null;
  positionName: string | null;
  title: string;
  dutiesText: string;
  competencies: IAdaptiveCompetencyInput[];
  isPublished: boolean;
  updatedAt: string;
  /** Содержимое загруженного .md со скиллом отдела. */
  skillMd: string | null;
  skillMdFilename: string | null;
  skillMdChars: number;
  skillMdUploadedAt: string | null;
}

/**
 * Файл — единственный источник содержания профиля: обязанности и компетенции
 * руками не вводятся, темы выделяет сервер из .md при сохранении.
 */
export interface IAdaptiveProfileInput {
  orgDepartmentId: string;
  positionId: string | null;
  title: string;
  isPublished: boolean;
  skillMd: string;
  skillMdFilename: string;
}

export interface IAdaptiveProfileSaveResult {
  id: string;
  competencies: IAdaptiveCompetencyInput[];
  /** true — методичку не удалось разобрать, сохранена одна общая тема. */
  competenciesFallback: boolean;
}

/** Лимит содержимого .md — синхронно с сервером (SKILL_MD_MAX_CHARS). */
export const SKILL_MD_MAX_CHARS = 150_000;

export interface IAdaptiveCoverageRow {
  departmentId: string;
  departmentName: string | null;
  positionId: string | null;
  positionName: string | null;
  employees: number;
  hasExactProfile: boolean;
  hasDepartmentProfile: boolean;
}

export interface IAdaptiveModelInfo {
  id: string;
  label: string;
  allowedForAdaptiveTesting: boolean;
}

export interface IAdaptiveSettings {
  enabled: boolean;
  model: string;
  allowedEmails: string;
  dailySessionsLimit: number;
  connectionMode: 'shared_proxy' | 'dedicated_proxy';
  zdrRequired: boolean;
  hasDedicatedApiKey: boolean;
  dedicatedBaseUrl: string | null;
  effectiveBaseUrl: string | null;
  trustedBaseUrls: string[];
  allowedModels: IAdaptiveModelInfo[];
}

export interface IAdaptiveSettingsPatch {
  enabled?: boolean;
  model?: string;
  allowedEmails?: string;
  dailySessionsLimit?: number;
  connectionMode?: 'shared_proxy' | 'dedicated_proxy';
  zdrRequired?: boolean;
  dedicated?: { apiKey: string; baseUrl: string } | null;
}

export interface IAdaptiveHealthCheck {
  ok: boolean;
  model?: string;
  finishReason?: string;
  error?: string;
  configReason?: string;
}

export const adaptiveTestingService = {
  // Сотрудник
  getAvailability: async (): Promise<IAdaptiveAvailability> => {
    const res = await apiClient.get<ApiResponse<IAdaptiveAvailability>>('/adaptive-testing/availability');
    return res.data;
  },
  startSession: async (): Promise<{ sessionId: string; resumed: boolean }> => {
    const res = await apiClient.post<ApiResponse<{ sessionId: string; resumed: boolean }>>('/adaptive-testing/sessions');
    return res.data;
  },
  getCurrent: async (): Promise<IAdaptiveCurrent> => {
    const res = await apiClient.get<ApiResponse<IAdaptiveCurrent>>('/adaptive-testing/sessions/current');
    return res.data;
  },
  submitAnswer: async (sessionId: string, questionId: string, answer: IAdaptiveAnswerInput): Promise<void> => {
    await apiClient.post(`/adaptive-testing/sessions/${sessionId}/answer`, { questionId, answer });
  },
  /** Разбор: сервер отдаёт ключ только по уже отвеченному вопросу. */
  getReveal: async (sessionId: string, questionId: string): Promise<IAdaptiveReveal> => {
    const res = await apiClient.get<ApiResponse<IAdaptiveReveal>>(
      `/adaptive-testing/sessions/${sessionId}/questions/${questionId}/reveal`,
    );
    return res.data;
  },
  retry: async (): Promise<void> => {
    await apiClient.post('/adaptive-testing/sessions/current/retry');
  },
  cancel: async (): Promise<void> => {
    await apiClient.post('/adaptive-testing/sessions/current/cancel');
  },
  listMyResults: async (): Promise<IAdaptiveResultListItem[]> => {
    const res = await apiClient.get<ApiResponse<IAdaptiveResultListItem[]>>('/adaptive-testing/results/my');
    return res.data;
  },
  getMyResultDetail: async (sessionId: string): Promise<IAdaptiveResultDetail> => {
    const res = await apiClient.get<ApiResponse<IAdaptiveResultDetail>>(`/adaptive-testing/results/my/${sessionId}`);
    return res.data;
  },

  // Руководитель / админ
  listResults: async (limit = 50, offset = 0): Promise<IAdaptiveResultListItem[]> => {
    const res = await apiClient.get<ApiResponse<IAdaptiveResultListItem[]>>(
      `/adaptive-testing/results?limit=${limit}&offset=${offset}`,
    );
    return res.data;
  },
  getResultDetail: async (sessionId: string): Promise<IAdaptiveResultDetail> => {
    const res = await apiClient.get<ApiResponse<IAdaptiveResultDetail>>(`/adaptive-testing/results/${sessionId}`);
    return res.data;
  },
  getCoverage: async (): Promise<IAdaptiveCoverageRow[]> => {
    const res = await apiClient.get<ApiResponse<IAdaptiveCoverageRow[]>>('/adaptive-testing/coverage');
    return res.data;
  },

  // Skill-профили (админ)
  listProfiles: async (): Promise<IAdaptiveProfile[]> => {
    const res = await apiClient.get<ApiResponse<IAdaptiveProfile[]>>('/adaptive-testing/skill-profiles');
    return res.data;
  },
  createProfile: async (input: IAdaptiveProfileInput): Promise<IAdaptiveProfileSaveResult> => {
    const res = await apiClient.post<ApiResponse<IAdaptiveProfileSaveResult>>('/adaptive-testing/skill-profiles', input);
    return res.data;
  },
  updateProfile: async (id: string, input: IAdaptiveProfileInput): Promise<IAdaptiveProfileSaveResult> => {
    const res = await apiClient.put<ApiResponse<IAdaptiveProfileSaveResult>>(`/adaptive-testing/skill-profiles/${id}`, input);
    return res.data;
  },

  // Настройки LLM
  getSettings: async (): Promise<IAdaptiveSettings> => {
    const res = await apiClient.get<ApiResponse<IAdaptiveSettings>>('/adaptive-testing/settings');
    return res.data;
  },
  saveSettings: async (patch: IAdaptiveSettingsPatch): Promise<IAdaptiveSettings> => {
    const res = await apiClient.put<ApiResponse<IAdaptiveSettings>>('/adaptive-testing/settings', patch);
    return res.data;
  },
  healthCheck: async (zdr: boolean): Promise<IAdaptiveHealthCheck> => {
    const res = await apiClient.post<ApiResponse<IAdaptiveHealthCheck>>('/adaptive-testing/settings/health-check', { zdr });
    return res.data;
  },
};
