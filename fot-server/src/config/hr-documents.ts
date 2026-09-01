/**
 * Каталог кадрового модуля («Реквизиты»): типы сканов, профили комплектов
 * документов, поля профиля. Фронт получает всё через GET /api/hr-profiles/catalog —
 * констант на клиенте не дублируем.
 *
 * Перенос из PassDesk (client/src/modules/employees/lib/documentTypeProfiles.js,
 * shared/config/employeeFields.js, utils/patentRequirement.js).
 */

export const HR_CATEGORY_PREFIX = 'hr_';
/** Ключ доступа вкладки «Кадровые данные» (technical, матрица ролей). */
export const PAGE_KEY_HR_PROFILES = '/staff-control/hr-profiles';

/** Тип скана → OCR-тип (null — не распознаётся, только хранится). */
export interface IHrDocumentType {
  code: string;
  label: string;
  ocrType: HrOcrType | null;
  sortOrder: number;
}

export type HrOcrType =
  | 'passport_rf'
  | 'foreign_passport'
  | 'passport_translation'
  | 'patent'
  | 'kig'
  | 'kig_back'
  | 'inn'
  | 'snils'
  | 'bank_details'
  | 'visa'
  | 'insurance_policy'
  | 'registration_amina';

export const HR_OCR_TYPES: readonly HrOcrType[] = [
  'passport_rf', 'foreign_passport', 'passport_translation', 'patent', 'kig', 'kig_back',
  'inn', 'snils', 'bank_details', 'visa', 'insurance_policy', 'registration_amina',
];

/** Коды без префикса hr_ (как в PassDesk document_type_enum). */
export const HR_DOCUMENT_TYPES: readonly IHrDocumentType[] = [
  { code: 'passport', label: 'Паспорт', ocrType: 'passport_rf', sortOrder: 10 },
  { code: 'passport_translation', label: 'Перевод паспорта', ocrType: 'passport_translation', sortOrder: 15 },
  { code: 'inn_document', label: 'ИНН', ocrType: 'inn', sortOrder: 18 },
  { code: 'bank_details', label: 'Реквизиты счета', ocrType: 'bank_details', sortOrder: 20 },
  { code: 'consent', label: 'Согласие на перс.дан. Подрядчик', ocrType: null, sortOrder: 30 },
  { code: 'kig', label: 'КИГ', ocrType: 'kig', sortOrder: 40 },
  { code: 'patent_front', label: 'Патент (лиц.)', ocrType: 'patent', sortOrder: 50 },
  { code: 'patent_back', label: 'Патент (спин.)', ocrType: 'patent', sortOrder: 60 },
  { code: 'biometric_consent', label: 'Согласие на перс.дан. Генподряд', ocrType: null, sortOrder: 70 },
  { code: 'biometric_consent_developer', label: 'Согласие на перс.дан. Застройщик', ocrType: null, sortOrder: 80 },
  { code: 'diploma', label: 'Диплом', ocrType: null, sortOrder: 90 },
  { code: 'snils_card', label: 'СНИЛС', ocrType: 'snils', sortOrder: 95 },
  { code: 'med_book', label: 'Мед.книжка', ocrType: null, sortOrder: 100 },
  { code: 'visa', label: 'Виза', ocrType: 'visa', sortOrder: 105 },
  { code: 'migration_card', label: 'Миграционная карта', ocrType: null, sortOrder: 110 },
  { code: 'arrival_notice', label: 'Уведомление о прибытии', ocrType: null, sortOrder: 120 },
  { code: 'patent_payment_receipt', label: 'Чек оплаты патента', ocrType: 'patent', sortOrder: 130 },
  { code: 'insurance_policy', label: 'Страховой полис', ocrType: 'insurance_policy', sortOrder: 135 },
  { code: 'mvd_notification', label: 'Уведомление МВД', ocrType: null, sortOrder: 140 },
  { code: 'memo_approval', label: 'Служебная записка (согласование)', ocrType: null, sortOrder: 150 },
  { code: 'employment_history_stdr', label: 'Справка о трудовой деятельности работника (СТДР)', ocrType: null, sortOrder: 160 },
  { code: 'registration_amina', label: 'Регистрация (Амина)', ocrType: 'registration_amina', sortOrder: 170 },
  { code: 'military_id', label: 'Военный билет', ocrType: null, sortOrder: 180 },
  { code: 'application_scan', label: 'Скан заявления', ocrType: null, sortOrder: 185 },
  { code: 'other', label: 'Иные документы', ocrType: null, sortOrder: 190 },
];

const HR_DOCUMENT_TYPE_MAP = new Map(HR_DOCUMENT_TYPES.map(t => [t.code, t]));

export const toHrCategory = (code: string): string => `${HR_CATEGORY_PREFIX}${code}`;
export const fromHrCategory = (category: string): string | null =>
  category.startsWith(HR_CATEGORY_PREFIX) ? category.slice(HR_CATEGORY_PREFIX.length) : null;
export const isHrCategory = (category: string | null | undefined): boolean =>
  typeof category === 'string' && category.startsWith(HR_CATEGORY_PREFIX);
export const getHrDocumentType = (codeOrCategory: string): IHrDocumentType | null =>
  HR_DOCUMENT_TYPE_MAP.get(fromHrCategory(codeOrCategory) ?? codeOrCategory) ?? null;

/**
 * Профили комплектов документов (PassDesk DEFAULT_DOCUMENT_PROFILES для дефолтного
 * контрагента — в FOT все свои). Порядок = порядок слотов в UI.
 */
export type HrDocumentProfile = 'ru' | 'eaeu' | 'migrant';

const BASE_CONSENTS = ['consent', 'biometric_consent', 'biometric_consent_developer'];
const BASE_EXTRA_DOCS = ['memo_approval', 'employment_history_stdr', 'registration_amina', 'military_id', 'other'];

export const HR_DOCUMENT_PROFILES: Record<HrDocumentProfile, readonly string[]> = {
  ru: ['passport', 'bank_details', ...BASE_CONSENTS, 'diploma', 'snils_card', 'insurance_policy', 'inn_document', ...BASE_EXTRA_DOCS],
  eaeu: ['passport', 'bank_details', ...BASE_CONSENTS, 'diploma', 'snils_card', 'insurance_policy', 'inn_document', 'migration_card', 'arrival_notice', ...BASE_EXTRA_DOCS],
  migrant: [
    'passport', 'passport_translation', 'kig', 'patent_front', 'patent_back', 'bank_details', ...BASE_CONSENTS,
    'snils_card', 'visa', 'arrival_notice', 'patent_payment_receipt', 'insurance_policy', 'inn_document',
    'migration_card', 'mvd_notification', 'med_book', ...BASE_EXTRA_DOCS,
  ],
};

/** «Обязательные» слоты профиля — для бейджа «полный комплект». */
export const HR_REQUIRED_DOCUMENTS: Record<HrDocumentProfile, readonly string[]> = {
  ru: ['passport', 'snils_card', 'inn_document'],
  eaeu: ['passport', 'snils_card', 'inn_document', 'migration_card'],
  migrant: ['passport', 'passport_translation', 'kig', 'patent_front', 'patent_back', 'snils_card', 'inn_document', 'migration_card'],
};

/** Сотруднику с ВНЖ патент/КИГ не нужны — эти слоты убираются из профиля. */
export const RESIDENCE_PERMIT_EXCLUDED_DOCUMENTS: readonly string[] = [
  'patent_front', 'patent_back', 'patent_payment_receipt', 'kig',
];

export interface IHrCitizenshipLike {
  requires_patent: boolean;
  is_eaeu: boolean;
}

/** Единый предикат «нужен ли патент» (порт PassDesk patentRequirement.js). */
export const requiresPatent = (
  citizenship: IHrCitizenshipLike | null | undefined,
  hasResidencePermit: boolean,
): boolean => !hasResidencePermit && !!citizenship && citizenship.requires_patent && !citizenship.is_eaeu;

export const resolveDocumentProfile = (
  citizenship: (IHrCitizenshipLike & { iso_code?: string | null; name?: string }) | null | undefined,
  hasResidencePermit: boolean,
): HrDocumentProfile => {
  if (!citizenship) return 'ru';
  const isRu = citizenship.iso_code === 'RUS' || citizenship.name === 'Россия';
  if (isRu) return 'ru';
  if (citizenship.is_eaeu) return 'eaeu';
  if (!citizenship.requires_patent && !hasResidencePermit) return 'ru';
  return 'migrant';
};

export const resolveDocumentSlots = (
  profile: HrDocumentProfile,
  hasResidencePermit: boolean,
): { all: string[]; required: string[] } => {
  const excluded = new Set(hasResidencePermit ? RESIDENCE_PERMIT_EXCLUDED_DOCUMENTS : []);
  return {
    all: HR_DOCUMENT_PROFILES[profile].filter(code => !excluded.has(code)),
    required: HR_REQUIRED_DOCUMENTS[profile].filter(code => !excluded.has(code)),
  };
};

/**
 * Поля профиля (ключ API → лейбл, группа). Чувствительные — шифруются и
 * маскируются без права edit.
 */
export interface IHrProfileFieldMeta {
  key: string;
  label: string;
  group: 'personal' | 'contacts' | 'documents' | 'patent' | 'other';
  sensitive?: boolean;
  /** Показывать только мигрантам без ВНЖ. */
  migrantOnly?: boolean;
  /** Поле живёт в employees (write-through), а не в профиле. */
  ownedByEmployee?: boolean;
}

export const HR_PROFILE_FIELDS: readonly IHrProfileFieldMeta[] = [
  { key: 'gender', label: 'Пол', group: 'personal' },
  { key: 'citizenship_id', label: 'Гражданство', group: 'personal' },
  { key: 'has_residence_permit', label: 'ВНЖ (вид на жительство)', group: 'personal' },
  { key: 'birth_date', label: 'Дата рождения', group: 'personal', ownedByEmployee: true },
  { key: 'birth_country_id', label: 'Страна рождения', group: 'personal' },
  { key: 'birth_region', label: 'Область рождения', group: 'personal' },
  { key: 'birth_city', label: 'Населённый пункт рождения', group: 'personal' },
  { key: 'registration_address', label: 'Адрес регистрации', group: 'personal' },
  { key: 'email', label: 'Email', group: 'contacts', ownedByEmployee: true },
  { key: 'phone', label: 'Телефон', group: 'contacts' },
  { key: 'snils', label: 'СНИЛС', group: 'documents', ownedByEmployee: true },
  { key: 'inn', label: 'ИНН', group: 'documents', sensitive: true },
  { key: 'passport_type', label: 'Тип паспорта', group: 'documents' },
  { key: 'passport_number', label: 'Серия и номер паспорта', group: 'documents', sensitive: true },
  { key: 'passport_date', label: 'Дата выдачи паспорта', group: 'documents' },
  { key: 'passport_issuer', label: 'Кем выдан паспорт', group: 'documents' },
  { key: 'passport_department_code', label: 'Код подразделения', group: 'documents' },
  { key: 'passport_expiry_date', label: 'Дата окончания паспорта', group: 'documents' },
  { key: 'bank_account_number', label: 'Номер банковского счета', group: 'documents', sensitive: true },
  { key: 'bank_bik', label: 'БИК', group: 'documents' },
  { key: 'insurance_policy_number', label: 'Номер страхового полиса', group: 'documents' },
  { key: 'insurance_policy_date', label: 'Дата выдачи полиса', group: 'documents' },
  { key: 'kig', label: 'КИГ', group: 'patent', sensitive: true, migrantOnly: true },
  { key: 'kig_end_date', label: 'Срок окончания КИГ', group: 'patent', migrantOnly: true },
  { key: 'patent_number', label: 'Номер патента', group: 'patent', sensitive: true, migrantOnly: true },
  { key: 'patent_issue_date', label: 'Дата выдачи патента', group: 'patent', migrantOnly: true, ownedByEmployee: true },
  { key: 'patent_expiry_date', label: 'Дата окончания патента', group: 'patent', migrantOnly: true, ownedByEmployee: true },
  { key: 'patent_blank_number', label: 'Номер бланка патента', group: 'patent', migrantOnly: true },
  { key: 'planned_exit_date', label: 'Планируемая дата выхода', group: 'other' },
  { key: 'notes', label: 'Примечания', group: 'other' },
];

export const HR_FIELD_GROUPS: Record<IHrProfileFieldMeta['group'], string> = {
  personal: 'Личные данные',
  contacts: 'Контакты',
  documents: 'Документы',
  patent: 'Патент и КИГ',
  other: 'Прочее',
};

/** Правка этих полей сбрасывает «ЗУП: ДА» → НЕТ (данные в 1С надо обновить). */
export const ZUP_RELEVANT_FIELDS: readonly string[] = [
  'birth_date', 'gender', 'citizenship_id', 'has_residence_permit', 'registration_address', 'phone',
  'snils', 'inn', 'passport_type', 'passport_number', 'passport_date', 'passport_issuer',
  'passport_department_code', 'passport_expiry_date', 'bank_account_number', 'bank_bik',
  'kig', 'kig_end_date', 'patent_number', 'patent_issue_date', 'patent_blank_number',
  'birth_country_id', 'birth_region', 'birth_city',
];

export const HR_SENSITIVE_FIELDS: readonly string[] = HR_PROFILE_FIELDS.filter(f => f.sensitive).map(f => f.key);
