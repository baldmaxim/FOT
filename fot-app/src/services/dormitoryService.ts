import { apiClient } from '../api/client';
import type { ITableExportSnapshot } from '../utils/tableView';

/** Общежитие компании или квартира — «Доплата за проживание» «Зарплаты» (миграция 320). */
export type DormitoryStayKind = 'dormitory' | 'apartment';

/** Проживание сотрудника (миграции 314, 320). Отдел и должность — текущие. */
export interface IDormitoryStay {
  id: number;
  employee_id: number;
  full_name: string;
  department: string | null;
  position: string | null;
  kind: DormitoryStayKind;
  /** YYYY-MM-DD. */
  check_in: string;
  /** YYYY-MM-DD; живёт — null. */
  check_out: string | null;
  /** У общежития — всегда; у квартиры — если указали. */
  address: string | null;
  /** Только у квартиры: ставка ₽/день (миграция 339), numeric строкой. */
  amount: string | null;
  /** Служебная квартира (миграция 371); общежитие и компенсация — null. Прежний бэкенд поле не присылает. */
  apartment_id?: number | null;
  /** «Платно» — только у жильца служебной квартиры. */
  paid?: boolean;
  comment?: string | null;
  /** ISO-время последней правки записи. */
  updated_at?: string;
  employment_status?: string | null;
  /** YYYY-MM-DD; работает — null. */
  dismissal_date?: string | null;
  org_department_id?: string | null;
  /** Гражданство (employees.country). */
  country?: string | null;
  /** Компенсация закрыта паузой, а не окончанием (миграция 374). Прежний бэкенд поле не присылает. */
  suspended?: boolean;
  /** Компенсация возобновлена из этой приостановленной записи (миграция 374). */
  resumed_from_id?: number | null;
}

/** Общежитие справочника (миграции 319, 377): как «Общежития» 1С. */
export interface IDormitory {
  id: number;
  /** Общежитие — название / адрес. */
  address: string;
  /** «Дата» — YYYY-MM-DD. */
  doc_date: string | null;
  /** «Номер» — как в 1С. */
  doc_number: string | null;
  /** «Стоимость места», ₽ — только для информации, numeric строкой. */
  place_price: string | null;
}

export interface IDormitoryPayload {
  address: string;
  doc_date: string | null;
  doc_number: string | null;
  place_price: number | null;
}

/** Служебная квартира компании (миграция 371). */
export interface ICompanyApartment {
  id: number;
  /** Без «Кв.». */
  address: string;
  /** «РФ \ ВНЖ», «семейная». */
  note: string | null;
  rooms: number | null;
  /** Справочно, не лимит. */
  places: number | null;
  /** Аренда ₽/мес, numeric строкой. */
  price: string | null;
  /** YYYY-MM-DD. */
  paid_until: string | null;
}

export interface ICompanyApartmentPayload {
  address: string;
  note: string | null;
  rooms: number | null;
  places: number | null;
  price: number | null;
  paid_until: string | null;
}

/** Жилец служебной квартиры: сведения — только у живущих сейчас. */
export interface IApartmentResident extends IDormitoryStay {
  phone: string | null;
  vacation_from: string | null;
  vacation_to: string | null;
  main_object: string | null;
}

export interface IApartmentsData {
  /** Сегодня по Москве (YYYY-MM-DD) — граница «живёт сейчас» и «история». */
  today: string;
  apartments: ICompanyApartment[];
  residents: IApartmentResident[];
}

/** Жилец общежития: сведения — только у записей, задевающих выбранный месяц. */
export interface IDormitoryResident extends IDormitoryStay {
  /** Полный номер — с правом правки «Реквизитов» или «Проживания», иначе последние 4 знака. */
  passport: string | null;
  /** YYYY-MM-DDTHH:MM:SS по Москве. */
  last_pass_at: string | null;
  last_access_point: string | null;
  supervisor: string | null;
}

export interface IDormitoryResidentsData {
  today: string;
  residents: IDormitoryResident[];
}

/** «Компенсация аренды» за месяц: дни и сумма — из расчёта ФОТ (null — месяц не посчитан). */
export interface ICompensationMonthRow extends IDormitoryStay {
  month: string;
  month_amount: string | null;
  worked_days: number | null;
  weekend_days: number | null;
  /** Начало первой записи цепочки «пауза → возобновление» (миграция 374); прежний бэкенд — нет, берётся check_in. */
  compensation_start?: string;
  /** Приостановлена с (YYYY-MM-DD); нет — null. */
  paused_from?: string | null;
  /** Возобновлена с (YYYY-MM-DD); нет — null. */
  resumed_from?: string | null;
  /** Период в бригаде, задевающий месяц: дни в бригаде компенсацией не оплачиваются. */
  brigade_from?: string | null;
  brigade_to?: string | null;
}

/** Переселение: в общежитие (адрес) или в служебную квартиру (id) — одно из двух. */
export type StayMoveTarget = { address: string } | { apartment_id: number };

/** Общежитие в «Справочнике» «Зарплаты»: только «штат зарплаты»; can_edit — можно ли убрать (🗑). */
export interface IPayrollDormitoryStay extends IDormitoryStay {
  can_edit: boolean;
}

/** Работающий сотрудник для «Добавить сотрудника». */
export interface IDormitoryCandidate {
  id: number;
  full_name: string;
  department: string | null;
  position: string | null;
}

export interface IDormitoryStayPayload {
  check_in: string;
  check_out: string | null;
  address: string | null;
  /** Только у квартиры. */
  amount: number | null;
}

interface IApiResponse<T> { success: boolean; data: T }

/** Общий префикс: правка во вкладке кадров перечитывает и таблицу «Справочника». */
export const DORMITORY_STAYS_KEY = ['dormitory-stays'] as const;
export const PAYROLL_DORMITORY_STAYS_KEY = [...DORMITORY_STAYS_KEY, 'payroll'] as const;
/** Под тем же префиксом: любая правка «Проживания» перечитывает и названия общежитий справочника. */
export const DORMITORY_ADDRESSES_KEY = [...DORMITORY_STAYS_KEY, 'addresses'] as const;
/** Справочник общежитий (миграция 377) — под тем же префиксом. */
export const DORMITORY_DIRECTORY_KEY = [...DORMITORY_STAYS_KEY, 'directory'] as const;
/** Вкладки «Проживания» (миграция 371) — под тем же префиксом: любая правка перечитывает открытые. */
export const DORMITORY_APARTMENTS_KEY = [...DORMITORY_STAYS_KEY, 'apartments'] as const;
export const DORMITORY_RESIDENTS_KEY = [...DORMITORY_STAYS_KEY, 'residents'] as const;
export const DORMITORY_COMPENSATION_KEY = [...DORMITORY_STAYS_KEY, 'compensation'] as const;

export const dormitoryService = {
  /** «Управление кадрами» → «Проживание»: общежития и квартиры, охват списка кадров. */
  list: async (signal?: AbortSignal): Promise<IDormitoryStay[]> => {
    const res = await apiClient.get<IApiResponse<IDormitoryStay[]>>('/dormitory/stays', { signal });
    return res.data;
  },

  /** «Зарплата» → «Справочник» → «Общежитие» (кнопка в шапке): только общежития работающих, охват условий оплаты. */
  listForPayroll: async (signal?: AbortSignal): Promise<IPayrollDormitoryStay[]> => {
    const res = await apiClient.get<IApiResponse<IPayrollDormitoryStay[]>>('/payroll/dormitory-stays', { signal });
    return res.data;
  },

  /**
   * «Зарплата» заселяет в общежитие (миграция 339: живущие не получают авто-доплату за общежитие). Пересечение с
   * другим проживанием — ApiError 409.
   */
  addForPayroll: async (employeeId: number, payload: IDormitoryStayPayload): Promise<IPayrollDormitoryStay> => {
    const res = await apiClient.post<IApiResponse<IPayrollDormitoryStay>>(
      '/payroll/dormitory-stays',
      { employee_id: employeeId, ...payload },
    );
    return res.data;
  },

  /** Названия общежитий справочника — окну заселения «Зарплаты», те же, что у кадров. */
  listAddressesForPayroll: async (signal?: AbortSignal): Promise<string[]> => {
    const res = await apiClient.get<IApiResponse<string[]>>('/payroll/dormitory-addresses', { signal });
    return res.data;
  },

  /** «Зарплата» выселяет из общежития: выезд — только раньше прежнего, въезд и адрес не меняются. */
  closeForPayroll: async (stayId: number, checkOut: string): Promise<void> => {
    await apiClient.patch(`/payroll/dormitory-stays/${stayId}`, { check_out: checkOut });
  },

  /** «Зарплата» удаляет ошибочную строку общежития. */
  removeForPayroll: async (stayId: number): Promise<void> => {
    await apiClient.delete(`/payroll/dormitory-stays/${stayId}`);
  },

  searchEmployees: async (search: string, signal?: AbortSignal): Promise<IDormitoryCandidate[]> => {
    const res = await apiClient.get<IApiResponse<IDormitoryCandidate[]>>(
      `/dormitory/employees/search?q=${encodeURIComponent(search)}`,
      { signal },
    );
    return res.data;
  },

  /** Названия общежитий справочника (миграции 319, 377) — выбор общежития при заселении, правке и переселении. */
  listAddresses: async (signal?: AbortSignal): Promise<string[]> => {
    const res = await apiClient.get<IApiResponse<string[]>>('/dormitory/addresses', { signal });
    return res.data;
  },

  /**
   * Пересечение с другим проживанием сотрудника — ApiError 409; квартира в днях «Доплаты за общежитие» или без
   * ставки «Доплата за проживание» (сумму квартиры сервер берёт из неё) — тоже 409.
   */
  add: async (
    employeeId: number,
    kind: DormitoryStayKind,
    payload: IDormitoryStayPayload,
    apartmentId: number | null = null,
  ): Promise<IDormitoryStay> => {
    const res = await apiClient.post<IApiResponse<IDormitoryStay>>(
      '/dormitory/stays',
      { employee_id: employeeId, kind, ...payload, ...(apartmentId !== null ? { apartment_id: apartmentId } : {}) },
    );
    return res.data;
  },

  /** «Платно» и/или комментарий — остальные поля записи не меняются. */
  updateMeta: async (stayId: number, meta: { paid?: boolean; comment?: string | null }): Promise<IDormitoryStay> => {
    const res = await apiClient.patch<IApiResponse<IDormitoryStay>>(`/dormitory/stays/${stayId}/meta`, meta);
    return res.data;
  },

  /** «Компенсация аренды» (миграция 374): приостановить с даты — с неё не начисляется. */
  suspendCompensation: async (stayId: number, date: string): Promise<IDormitoryStay> => {
    const res = await apiClient.post<IApiResponse<IDormitoryStay>>(`/dormitory/stays/${stayId}/suspend`, { date });
    return res.data;
  },

  /** Возобновить приостановленную с даты (не раньше паузы): новая запись с той же ставкой и комментарием. */
  resumeCompensation: async (stayId: number, date: string): Promise<IDormitoryStay> => {
    const res = await apiClient.post<IApiResponse<IDormitoryStay>>(`/dormitory/stays/${stayId}/resume`, { date });
    return res.data;
  },

  /** Завершить без возобновления: пауза становится окончанием, в следующих месяцах строки нет. */
  finishCompensationPause: async (stayId: number): Promise<IDormitoryStay> => {
    const res = await apiClient.post<IApiResponse<IDormitoryStay>>(`/dormitory/stays/${stayId}/finish-pause`, {});
    return res.data;
  },

  /**
   * Переселить с даты (с 1-го числа текущего месяца по сегодня): прежняя запись закрывается, новая — с этой даты;
   * комментарий новой записи — пусто: переносится прежний.
   */
  move: async (stayId: number, date: string, target: StayMoveTarget, comment: string | null = null): Promise<void> => {
    await apiClient.post(`/dormitory/stays/${stayId}/move`, { date, ...target, ...(comment ? { comment } : {}) });
  },

  /** Справочник общежитий (миграция 377): Дата, Номер, Общежитие, Стоимость места. */
  listDormitories: async (signal?: AbortSignal): Promise<IDormitory[]> => {
    const res = await apiClient.get<IApiResponse<IDormitory[]>>('/dormitory/dormitories', { signal });
    return res.data;
  },

  /** Такое название уже есть — ApiError 409. */
  addDormitory: async (payload: IDormitoryPayload): Promise<IDormitory> => {
    const res = await apiClient.post<IApiResponse<IDormitory>>('/dormitory/dormitories', payload);
    return res.data;
  },

  /** Новое название меняется и у всех записей общежития (в том числе в «Истории»). */
  updateDormitory: async (id: number, payload: IDormitoryPayload): Promise<IDormitory> => {
    const res = await apiClient.patch<IApiResponse<IDormitory>>(`/dormitory/dormitories/${id}`, payload);
    return res.data;
  },

  /** Только общежитие, где никто никогда не жил, — иначе ApiError 409. */
  removeDormitory: async (id: number): Promise<void> => {
    await apiClient.delete(`/dormitory/dormitories/${id}`);
  },

  /** Вкладка «Квартира»: квартиры и жильцы (сейчас и история) в охвате списка кадров. */
  listApartments: async (signal?: AbortSignal): Promise<IApartmentsData> => {
    const res = await apiClient.get<IApiResponse<IApartmentsData>>('/dormitory/apartments', { signal });
    return res.data;
  },

  addApartment: async (payload: ICompanyApartmentPayload): Promise<ICompanyApartment> => {
    const res = await apiClient.post<IApiResponse<ICompanyApartment>>('/dormitory/apartments', payload);
    return res.data;
  },

  /** Новый адрес меняется и у всех проживаний квартиры. */
  updateApartment: async (id: number, payload: ICompanyApartmentPayload): Promise<ICompanyApartment> => {
    const res = await apiClient.patch<IApiResponse<ICompanyApartment>>(`/dormitory/apartments/${id}`, payload);
    return res.data;
  },

  /** Только квартиру без жильцов и истории — иначе ApiError 409. */
  removeApartment: async (id: number): Promise<void> => {
    await apiClient.delete(`/dormitory/apartments/${id}`);
  },

  /** Вкладка «Общежитие»: все записи общежитий (с историей) со сведениями у живших в месяце YYYY-MM. */
  listResidents: async (month: string, signal?: AbortSignal): Promise<IDormitoryResidentsData> => {
    const res = await apiClient.get<IApiResponse<IDormitoryResidentsData>>(
      `/dormitory/residents?month=${encodeURIComponent(month)}`,
      { signal },
    );
    return res.data;
  },

  /** Вкладка «Компенсация аренды» за месяц YYYY-MM. */
  listCompensation: async (month: string, signal?: AbortSignal): Promise<ICompensationMonthRow[]> => {
    const res = await apiClient.get<IApiResponse<ICompensationMonthRow[]>>(
      `/dormitory/compensation?month=${encodeURIComponent(month)}`,
      { signal, timeoutMs: 120_000 },
    );
    return res.data;
  },

  update: async (stayId: number, payload: IDormitoryStayPayload): Promise<IDormitoryStay> => {
    const res = await apiClient.patch<IApiResponse<IDormitoryStay>>(`/dormitory/stays/${stayId}`, payload);
    return res.data;
  },

  remove: async (stayId: number): Promise<void> => {
    await apiClient.delete<IApiResponse<IDormitoryStay>>(`/dormitory/stays/${stayId}`);
  },

  /** xlsx ровно той таблицы, что на экране: сортировка и фильтры уже применены. */
  exportTable: async (table: ITableExportSnapshot): Promise<{ blob: Blob; filename: string }> =>
    apiClient.download('/dormitory/stays/export', table.file_name, {
      method: 'POST',
      body: JSON.stringify(table),
      timeoutMs: 120_000,
    }),
};
