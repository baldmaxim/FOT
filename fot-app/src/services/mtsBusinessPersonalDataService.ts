import { apiClient } from '../api/client';

// Персональные данные пользователя номера (МТС Бизнес): чтение ФИО/статуса
// подтверждения, внесение/изменение и удаление (транзитом в МТС, асинхронно:
// SMS → Госуслуги), журнал заявок. Поля формы НИГДЕ на портале не сохраняются.

export type MtsPdStatus =
  | 'Depersonalized'
  | 'NotRequired'
  | 'Migration'
  | 'Anonymous'
  | 'WaitingForAcceptance'
  | 'WaitingForCheck'
  | 'Activated'
  | 'ActivatedPortIn'
  | 'MismatchOfData'
  | 'NotFoundInEsia'
  | 'Refusal'
  | 'RequestNotFoundInEsia'
  | string;

export interface IMtsPdEmployeePrefill {
  id: number;
  lastName: string | null;
  firstName: string | null;
  middleName: string | null;
  birthDate: string | null;
  country: string | null;
}

export interface IMtsPdRequestRow {
  messageId: string;
  accountId: string | null;
  msisdn: string | null;
  operation: string; // 'change' | 'delete'
  status: string;
  statusDetail: string | null;
  requestedAt: string;
  checkedAt: string | null;
}

export interface IMtsPdInfo {
  msisdn: string;
  accountId: string;
  fullName?: string | null;
  confirmationStatus?: MtsPdStatus | null;
  unavailable?: true;
  reason?: string;
  employee: IMtsPdEmployeePrefill | null;
  requests: IMtsPdRequestRow[];
}

export interface IMtsPdDocument {
  series?: string;
  number: string;
  dateIssued: string; // YYYY-MM-DD
  issuer?: string;
  issuerCode?: string;  // ХХХ-ХХХ (паспорт РФ)
  countryCode?: string; // страна иностранного документа
}

export interface IMtsPdAddress {
  region: string;
  city: string;
  street: string;
  home: string;
  apartment?: string;
  zip: string;
}

export interface IMtsPdPerson {
  surName: string;
  firstName: string;
  secondName?: string;
  gender: 'Male' | 'Female';
  birthday: string; // YYYY-MM-DD
  birthPlace?: string;
  citizenship: 'RU' | 'FOREIGN';
  document: IMtsPdDocument;
  address?: IMtsPdAddress;
}

interface ApiResponse<T> {
  success: boolean;
  data: T;
}

export const mtsBusinessPersonalDataService = {
  getInfo: async (msisdn: string): Promise<IMtsPdInfo> => {
    const res = await apiClient.get<ApiResponse<IMtsPdInfo>>(`/mts-business/personal-data/${encodeURIComponent(msisdn)}`);
    return res.data;
  },

  submit: async (msisdn: string, person: IMtsPdPerson): Promise<{ messageId: string }> => {
    const res = await apiClient.post<ApiResponse<{ messageId: string }>>('/mts-business/personal-data', {
      msisdn, person, confirmed: true,
    });
    return res.data;
  },

  remove: async (msisdn: string): Promise<{ messageId: string }> => {
    const res = await apiClient.post<ApiResponse<{ messageId: string }>>('/mts-business/personal-data/delete', {
      msisdn, confirmed: true,
    });
    return res.data;
  },

  listRequests: async (): Promise<IMtsPdRequestRow[]> => {
    const res = await apiClient.get<ApiResponse<IMtsPdRequestRow[]>>('/mts-business/personal-data/requests');
    return res.data;
  },

  refreshRequestStatus: async (messageId: string): Promise<{ messageId: string; status: string }> => {
    const res = await apiClient.post<ApiResponse<{ messageId: string; status: string }>>(
      `/mts-business/personal-data/requests/${encodeURIComponent(messageId)}/refresh-status`, {},
    );
    return res.data;
  },
};
