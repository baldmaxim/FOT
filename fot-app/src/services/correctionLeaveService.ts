import { apiClient } from '../api/client';
import type { ILeaveRequestAttachment } from './leaveRequestService';

// Отпуска, поставленные корректировкой табеля, во вкладке «Отпуска» (миграция 311).
// Карточка вычисляется на сервере из табеля; version — снимок дней, типа и файлов:
// «Ознакомлен» и «Отказать» сервер выполняет, только если карточка не изменилась.

export type CorrectionLeaveStatus = 'vacation' | 'unpaid' | 'educational_leave';

interface IHrCorrectionBase {
  key: string;
  employee_id: number;
  employee_name: string | null;
  department_name: string | null;
  position_name: string | null;
  leave_status: CorrectionLeaveStatus;
  start_date: string;
  end_date: string;
  days: string[];
  author_name: string | null;
  last_changed_at: string;
  hr_acknowledged_at: string | null;
  hr_acknowledged_by_name: string | null;
}

/** Отпуск корректировкой: «Ознакомлен» / «Отказать». */
export interface IHrCorrectionLeave extends IHrCorrectionBase {
  kind: 'correction';
  adjustment_ids: number[];
  version: string;
  reason: string | null;
  attachments: ILeaveRequestAttachment[];
}

/** Дни, снятые из табеля после ознакомления кадров. */
export interface IHrCorrectionRemoved extends IHrCorrectionBase {
  kind: 'removed';
  adjustment_ids: number[];
  removed_kind: 'deleted' | 'status_changed' | 'mixed';
  removed_at: string;
}

/** Отказ кадров (дни уже удалены из табеля). */
export interface IHrCorrectionRejected extends IHrCorrectionBase {
  kind: 'rejected';
  id: number;
  reason: string | null;
  rejected_at: string;
  rejected_by_name: string | null;
  reject_reason: string;
}

export type HrCorrectionItem = IHrCorrectionLeave | IHrCorrectionRemoved | IHrCorrectionRejected;

/** Лимит причины отказа — тот же, что на бэкенде (correction-leave-decisions.service.ts). */
export const CORRECTION_REJECT_REASON_MAX_LENGTH = 500;

interface ApiResponse<T> {
  success: boolean;
  data: T;
  error?: string;
}

export const correctionLeaveService = {
  list: async (): Promise<HrCorrectionItem[]> => {
    const res = await apiClient.get<ApiResponse<HrCorrectionItem[]>>('/leave-requests/vacations/corrections');
    return res.data;
  },

  acknowledge: async (item: IHrCorrectionLeave): Promise<void> => {
    await apiClient.post('/leave-requests/vacations/corrections/acknowledge', {
      adjustment_ids: item.adjustment_ids,
      version: item.version,
    });
  },

  acknowledgeRemoved: async (item: IHrCorrectionRemoved): Promise<void> => {
    await apiClient.post('/leave-requests/vacations/corrections/removed/acknowledge', {
      adjustment_ids: item.adjustment_ids,
    });
  },

  reject: async (item: IHrCorrectionLeave, reason: string): Promise<void> => {
    await apiClient.post('/leave-requests/vacations/corrections/reject', {
      adjustment_ids: item.adjustment_ids,
      version: item.version,
      reason,
    });
  },

  /** Ссылка на файл карточки: сервер отдаёт только файлы видимых во вкладке дней. */
  getFileUrl: async (documentId: number, disposition: 'inline' | 'attachment'): Promise<string> => {
    const res = await apiClient.get<ApiResponse<{ download_url: string; file_name: string }>>(
      `/leave-requests/vacations/corrections/files/${documentId}/url?disposition=${disposition}`,
    );
    return res.data.download_url;
  },
};
