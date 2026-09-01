import type { IHrCatalog, IHrFieldMeta, IHrProfileFields } from '../../../types/hrProfile';

export const fmtDate = (v: string | null | undefined): string => {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleDateString('ru-RU');
};

export const fmtDateTime = (v: string | null | undefined): string => {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return `${d.toLocaleDateString('ru-RU')} ${d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
};

export const fmtBytes = (n: number): string => {
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} КБ`;
  return `${(n / (1024 * 1024)).toFixed(1)} МБ`;
};

export const DATE_FIELDS = new Set(['birth_date', 'passport_date', 'passport_expiry_date', 'kig_end_date', 'patent_issue_date', 'patent_expiry_date', 'insurance_policy_date', 'planned_exit_date']);

export const GENDER_LABEL: Record<string, string> = { male: 'Мужской', female: 'Женский' };
export const PASSPORT_TYPE_LABEL: Record<string, string> = { russian: 'Паспорт РФ', foreign: 'Иностранного гражданина' };

/** Человекочитаемое значение поля профиля. */
export const displayFieldValue = (key: string, value: unknown, catalog: IHrCatalog | undefined): string => {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Да' : 'Нет';
  if (DATE_FIELDS.has(key)) return fmtDate(String(value));
  if (key === 'gender') return GENDER_LABEL[String(value)] ?? String(value);
  if (key === 'passport_type') return PASSPORT_TYPE_LABEL[String(value)] ?? String(value);
  if (key === 'citizenship_id' || key === 'birth_country_id') {
    return catalog?.citizenships.find(c => c.id === value)?.name ?? '—';
  }
  return String(value);
};

/** Видимые поля с учётом профиля (патент/КИГ — только мигрантам без ВНЖ). */
export const visibleFields = (fields: IHrFieldMeta[], requiresPatent: boolean): IHrFieldMeta[] =>
  fields.filter(f => !f.migrantOnly || requiresPatent);

export const emptyProfileFields = (): IHrProfileFields => ({
  gender: null, citizenship_id: null, has_residence_permit: false, birth_date: null, birth_country_id: null,
  birth_region: null, birth_city: null, registration_address: null, email: null, phone: null, snils: null, inn: null,
  passport_type: null, passport_number: null, passport_date: null, passport_issuer: null, passport_department_code: null,
  passport_expiry_date: null, bank_account_number: null, bank_bik: null, insurance_policy_number: null, insurance_policy_date: null,
  kig: null, kig_end_date: null, patent_number: null, patent_issue_date: null, patent_expiry_date: null, patent_blank_number: null,
  planned_exit_date: null, notes: null,
});

export const FIELD_PLACEHOLDERS: Record<string, string> = {
  inn: 'XXXXXXXXXXXX',
  snils: '123-456-789 00',
  passport_number: '4510 123456',
  passport_department_code: '770-001',
  passport_issuer: 'ГУ МВД России по г. Москве',
  registration_address: 'г. Москва, ул. Тверская, д. 21, кв. 11',
  phone: '+7 (999) 123-45-67',
  bank_account_number: '40817810900000000000',
  bank_bik: '044525225',
  kig: 'AB1234567',
  patent_number: '77 №1234567890',
  patent_blank_number: 'ПР1234567',
  insurance_policy_number: '25285324 065197',
};

/** Требуется ли патент по выбранному гражданству и ВНЖ (для формы, где профиля ещё нет). */
export const requiresPatentFor = (catalog: IHrCatalog | undefined, citizenshipId: string | null | undefined, hasResidencePermit: boolean): boolean => {
  const cit = catalog?.citizenships.find(c => c.id === citizenshipId);
  return !hasResidencePermit && !!cit && cit.requires_patent && !cit.is_eaeu;
};

export const documentSlotsFor = (catalog: IHrCatalog | undefined, citizenshipId: string | null | undefined, hasResidencePermit: boolean): { all: string[]; required: string[] } => {
  if (!catalog) return { all: [], required: [] };
  const cit = catalog.citizenships.find(c => c.id === citizenshipId);
  let profile: 'ru' | 'eaeu' | 'migrant' = 'ru';
  if (cit) {
    if (cit.iso_code === 'RUS') profile = 'ru';
    else if (cit.is_eaeu) profile = 'eaeu';
    else if (!cit.requires_patent && !hasResidencePermit) profile = 'ru';
    else profile = 'migrant';
  }
  const excluded = new Set(hasResidencePermit ? catalog.residence_permit_excluded : []);
  return {
    all: catalog.profiles[profile].filter(c => !excluded.has(c)),
    required: catalog.required_documents[profile].filter(c => !excluded.has(c)),
  };
};
