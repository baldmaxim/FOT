import { apiClient } from '../api/client';
import type { IDepartmentStat } from './feedbackService';

interface ApiResponse<T> {
  data: T;
  success?: boolean;
}

export type QuestionType = 'single' | 'multiple' | 'text';
export type ResponseStatus = 'draft' | 'submitted';

export interface ITestOption {
  id: string;
  position: number;
  text: string;
}
export interface ITestQuestion {
  id: string;
  position: number;
  text: string;
  type: QuestionType;
  allow_custom: boolean;
  is_required: boolean;
  options: ITestOption[];
}
export interface ITestFull {
  id: string;
  title: string;
  description: string | null;
  active_from: string | null;
  active_to: string | null;
  is_active: boolean;
  questions: ITestQuestion[];
  department_ids?: string[];
}

export interface IAvailableTest {
  id: string;
  title: string;
  description: string | null;
  active_from: string | null;
  active_to: string | null;
  my_status: ResponseStatus | null;
}

export interface ITestListItem {
  id: string;
  title: string;
  description: string | null;
  active_from: string | null;
  active_to: string | null;
  is_active: boolean;
  created_at: string;
  question_count: number;
  assignment_count: number;
  submitted_count: number;
  department_ids: string[];
}

export interface IAnswerInput {
  question_id: string;
  selected_option_ids?: string[];
  custom_text?: string | null;
}

export interface IMyResponse {
  status: ResponseStatus;
  answers: Array<{ question_id: string; selected_option_ids: string[]; custom_text: string | null }>;
}

export interface ITestResponseRow {
  id: string;
  status: ResponseStatus;
  submitted_at: string | null;
  updated_at: string;
  full_name: string | null;
  department_name: string | null;
}

// ---- ввод конструктора теста ----
export interface ITestQuestionInput {
  text: string;
  type: QuestionType;
  allow_custom?: boolean;
  is_required?: boolean;
  options?: Array<{ text: string }>;
}
export interface ITestInput {
  title: string;
  description?: string | null;
  active_from?: string | null;
  active_to?: string | null;
  questions: ITestQuestionInput[];
}

export const testsService = {
  // Сотрудник
  getAvailable: async (): Promise<IAvailableTest[]> => {
    const res = await apiClient.get<ApiResponse<IAvailableTest[]>>('/tests/available');
    return res.data;
  },
  take: async (id: string): Promise<ITestFull> => {
    const res = await apiClient.get<ApiResponse<ITestFull>>(`/tests/${id}/take`);
    return res.data;
  },
  getMyResponse: async (id: string): Promise<IMyResponse | null> => {
    const res = await apiClient.get<ApiResponse<IMyResponse | null>>(`/tests/${id}/my-response`);
    return res.data;
  },
  saveResponse: async (id: string, status: ResponseStatus, answers: IAnswerInput[]): Promise<void> => {
    await apiClient.post(`/tests/${id}/response`, { status, answers });
  },

  // Администратор
  list: async (): Promise<ITestListItem[]> => {
    const res = await apiClient.get<ApiResponse<ITestListItem[]>>('/tests');
    return res.data;
  },
  getFull: async (id: string): Promise<ITestFull> => {
    const res = await apiClient.get<ApiResponse<ITestFull>>(`/tests/${id}`);
    return res.data;
  },
  create: async (input: ITestInput): Promise<{ id: string }> => {
    const res = await apiClient.post<ApiResponse<{ id: string }>>('/tests', input);
    return res.data;
  },
  update: async (id: string, input: ITestInput): Promise<void> => {
    await apiClient.put(`/tests/${id}`, input);
  },
  deactivate: async (id: string): Promise<void> => {
    await apiClient.delete(`/tests/${id}`);
  },
  setAssignments: async (id: string, departmentIds: string[]): Promise<void> => {
    await apiClient.put(`/tests/${id}/assignments`, { department_ids: departmentIds });
  },
  listResponses: async (id: string): Promise<ITestResponseRow[]> => {
    const res = await apiClient.get<ApiResponse<ITestResponseRow[]>>(`/tests/${id}/responses`);
    return res.data;
  },
  getStats: async (testId: string): Promise<IDepartmentStat[]> => {
    const res = await apiClient.get<ApiResponse<IDepartmentStat[]>>(`/tests/stats?test_id=${testId}`);
    return res.data;
  },
};
