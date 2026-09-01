import { z } from 'zod';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const nullableText = (max: number) => z.string().trim().max(max).nullable().optional();
const nullableDate = () => z.string().regex(ISO_DATE, 'Дата в формате YYYY-MM-DD').nullable().optional();

/** Поля профиля (ключи как в HR_PROFILE_FIELDS). Нормализация номеров — в сервисе. */
export const hrProfileInputSchema = z.object({
  gender: z.enum(['male', 'female']).nullable().optional(),
  citizenship_id: z.string().uuid().nullable().optional(),
  has_residence_permit: z.boolean().optional(),
  birth_date: nullableDate(),
  birth_country_id: z.string().uuid().nullable().optional(),
  birth_region: nullableText(200),
  birth_city: nullableText(200),
  registration_address: nullableText(500),
  email: z.string().trim().email().max(200).nullable().optional().or(z.literal('').transform(() => null)),
  phone: nullableText(40),
  snils: nullableText(20),
  inn: nullableText(20),
  passport_type: z.enum(['russian', 'foreign']).nullable().optional(),
  passport_number: nullableText(30),
  passport_date: nullableDate(),
  passport_issuer: nullableText(300),
  passport_department_code: nullableText(10),
  passport_expiry_date: nullableDate(),
  bank_account_number: nullableText(30),
  bank_bik: nullableText(12),
  insurance_policy_number: nullableText(64),
  insurance_policy_date: nullableDate(),
  kig: nullableText(20),
  kig_end_date: nullableDate(),
  patent_number: nullableText(30),
  patent_issue_date: nullableDate(),
  patent_expiry_date: nullableDate(),
  patent_blank_number: nullableText(20),
  planned_exit_date: nullableDate(),
  notes: nullableText(2000),
}).strict();

export type HrProfileInputDto = z.infer<typeof hrProfileInputSchema>;
