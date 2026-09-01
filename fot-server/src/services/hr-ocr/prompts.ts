/**
 * Промпты распознавания кадровых документов. Перенесены из PassDesk
 * (server/src/services/ocr/ocrService.js) ДОСЛОВНО — они обкатаны на реальных
 * сканах; правки только через переопределения в system_settings
 * (ключ hr_ocr_prompts, JSON {<type>: <prompt>, fallback_inn, fallback_snils}).
 */
import type { HrOcrType } from '../../config/hr-documents.js';
import { settingsService } from '../settings.service.js';

export const HR_OCR_PROMPTS_SETTING_KEY = 'hr_ocr_prompts';
const PROMPTS_CACHE_TTL_MS = 60_000;

export const SYSTEM_PROMPT =
  'Ты извлекаешь структурированные данные из документов. Если поле не найдено, верни null.';

const NAME_CASE_INSTRUCTION =
  'Поля surname, givenNames, middleName пиши строго на кириллице и с заглавной буквы (Titlecase), например: Иванов, Иван, Иванович. ' +
  'Если в документе ФИО написано латиницей или есть MRZ-зона — всё равно верни кириллицу, транслитерировав обратно. Не пиши заглавными буквами целиком. ';

const DATE_FORMAT_INSTRUCTION =
  'Все поля с датами (birthDate, issueDate, expiryDate и др.) возвращай строго в формате YYYY-MM-DD (только дата, без времени, без часов, минут и секунд). Пример: 2022-06-15.';

export const DEFAULT_PROMPTS: Record<HrOcrType, string> = {
  passport_rf:
    'Распознай паспорт РФ на фото, даже при плохом качестве, шуме, перспективных искажениях и частичных засветах. ' +
    NAME_CASE_INSTRUCTION +
    DATE_FORMAT_INSTRUCTION +
    "Поле sex: верни строго 'M' если мужской пол, 'F' если женский. Не используй другие варианты. " +
    'Верни строго JSON без markdown и пояснений. Поля: surname, givenNames, middleName, birthDate, sex, nationality, ' +
    'passportSeries, passportNumber, issueDate, authority, departmentCode, birthPlace, expiryDate.',
  foreign_passport:
    'Распознай иностранный паспорт на фото, включая кривую перспективу и шум. ' +
    'ВАЖНО: ФИО на оригинале иностранного паспорта написано латиницей или MRZ. ' +
    'Для полей surname, givenNames, middleName ВСЕГДА верни null — ФИО берутся ТОЛЬКО из отдельного нотариального перевода паспорта (документ типа passport_translation). ' +
    'Распознай только не-ФИО поля. ' +
    DATE_FORMAT_INSTRUCTION +
    "Поле sex: верни строго 'M' если мужской пол, 'F' если женский. Не используй другие варианты. " +
    'Поле expiryDate: срок действия иностранного паспорта обычно составляет 5 или 10 лет от даты выдачи. Если дата окончания явно указана в документе — бери её. ' +
    'Поле birthPlace: если указано только название страны без конкретного города или населённого пункта — верни null. Заполняй birthPlace ТОЛЬКО если указан конкретный город или населённый пункт. ' +
    'Верни строго JSON без markdown и пояснений. Поля: surname (null), givenNames (null), middleName (null), birthDate, sex, nationality, ' +
    'passportNumber, issueDate, authority, expiryDate, birthPlace.',
  passport_translation:
    'На фото нотариальный перевод иностранного паспорта на русский язык. ' +
    "Это НЕ оригинал паспорта, а его перевод — страницы содержат русские подписи полей ('Фамилия', 'Имя', 'Гражданство', 'Дата рождения', 'Место рождения', 'Место жительства' и т.д.). " +
    "В шапке документа может быть написано название страны выдачи паспорта (например 'РЕСПУБЛИКА МОЛДОВА', 'АРМЕНИЯ') — НЕ используй это как гражданство и НЕ путай с данными полей. " +
    "Гражданство бери ТОЛЬКО из поля с подписью 'Гражданство' или 'Гражданин(ка)'. " +
    "Место жительства или регистрации бери ТОЛЬКО из поля с подписью 'Место жительства', 'Место проживания', 'Адрес регистрации' или 'Зарегистрирован(а)' — если такого поля нет, верни null для registrationAddress. " +
    "Поле birthPlace: бери ТОЛЬКО из поля с подписью 'Место рождения'. " +
    "ВАЖНО: если в поле 'Место рождения' указано только название страны или республики (например 'РЕСПУБЛИКА МОЛДОВА', 'АРМЕНИЯ', 'УКРАИНА') без конкретного города или населённого пункта — верни null для birthPlace. Заполняй birthPlace ТОЛЬКО если указан конкретный город, район или населённый пункт. " +
    NAME_CASE_INSTRUCTION +
    DATE_FORMAT_INSTRUCTION +
    "Поле sex: верни строго 'M' если мужской пол, 'F' если женский. Не используй другие варианты. " +
    'Верни строго JSON без markdown и пояснений. Поля: surname, givenNames, middleName, birthDate, sex, nationality, ' +
    'passportNumber, issueDate, authority, expiryDate, birthPlace, registrationAddress.',
  patent:
    'Распознай патент на работу на фото (включая сложные условия съемки). ' +
    'Если это оборотная сторона и виден номер бланка вида 2 буквы + 7 цифр, верни его в поле blankNumber и НЕ записывай его в patentNumber. ' +
    'Для blankNumber префикс используй на кириллице: ориентируйся на формат ПР + 7 цифр. Если распозналось ПП, но это номер бланка, исправь на ПР. Не используй латиницу. ' +
    NAME_CASE_INSTRUCTION +
    DATE_FORMAT_INSTRUCTION +
    'Верни строго JSON без markdown и пояснений. Поля: patentNumber, issueDate, expiryDate, surname, givenNames, middleName, birthDate, nationality, blankNumber.',
  kig:
    'На фото карта иностранного гражданина (КИГ). Это может быть как лицевая, так и оборотная сторона. ' +
    'Сначала определи сторону документа по содержимому. ' +
    'Если это лицевая сторона, на ней есть только номер карты (2 буквы + 7 цифр, например AB0339982). В этом случае верни kigNumber и не придумывай остальные поля. ' +
    'Если это оборотная сторона, извлеки ФИО, дату рождения, пол, гражданство, номер карты и срок действия. ' +
    'На оборотной стороне может встречаться длинный внутренний числовой идентификатор. НЕ записывай такой номер в kigNumber. Поле kigNumber заполняй только если явно виден карточный номер формата 2 буквы + 7 цифр. ' +
    'Для оборотной стороны бери ФИО из кириллической области карты, а не из латинской MRZ-строки. ' +
    NAME_CASE_INSTRUCTION +
    DATE_FORMAT_INSTRUCTION +
    'Верни ПОЛНЫЙ номер карты в поле kigNumber, не сокращай. ' +
    'Если какого-то поля на конкретной стороне нет, верни null или не указывай его. ' +
    'Верни строго JSON без markdown и пояснений. Поля: surname, givenNames, middleName, birthDate, sex, nationality, kigNumber, expiryDate.',
  kig_back:
    'На фото оборотная сторона карты иностранного гражданина (КИГ). ' +
    'На ней есть ФИО, дата рождения, пол, гражданство, номер карты (77...) и срок действия. ' +
    'Бери ФИО из кириллической области карты (НЕ из MRZ-строки внизу с латиницей). ФИО пиши строго на кириллице. ' +
    NAME_CASE_INSTRUCTION +
    DATE_FORMAT_INSTRUCTION +
    'Верни строго JSON без markdown и пояснений. Поля: surname, givenNames, middleName, birthDate, sex, nationality, kigNumber, expiryDate.',
  inn:
    'Распознай свидетельство ИНН на фото. ' +
    'Поле ИНН на документе содержит ровно 12 цифр и обычно напечатано крупно в верхней части бланка, отдельной большой строкой. ' +
    'Ищи именно основной номер свидетельства рядом с заголовком документа, а не числа из печатей, QR-кодов, штрихкодов, электронной подписи или служебных блоков внизу. ' +
    'Обязательно верни эти 12 цифр в поле inn без пробелов и других символов. ' +
    'Не подставляй null, если номер читается хотя бы с умеренной уверенностью: выбери наиболее вероятную 12-значную последовательность на документе. ' +
    NAME_CASE_INSTRUCTION +
    DATE_FORMAT_INSTRUCTION +
    'Верни строго JSON без markdown и пояснений. Поля: inn, surname, givenNames, middleName, birthDate.',
  snils:
    'Распознай карточку СНИЛС на фото. ' +
    'Номер СНИЛС содержит ровно 11 цифр и часто записан как XXX-XXX-XXX XX. ' +
    "Ищи именно строку рядом с подписью 'Страховой номер индивидуального лицевого счета (СНИЛС)' или короткой подписью 'СНИЛС' в верхней части документа. " +
    'Игнорируй любые другие длинные номера из штампов, регистрационных блоков, электронной подписи, QR-кодов и служебных полей внизу документа. ' +
    'Обязательно верни номер в поле snils, сохранив все 11 цифр; можно без дефисов и пробелов. ' +
    'Не подставляй null, если номер читается хотя бы с умеренной уверенностью: выбери наиболее вероятный номер СНИЛС на документе. ' +
    NAME_CASE_INSTRUCTION +
    DATE_FORMAT_INSTRUCTION +
    'Верни строго JSON без markdown и пояснений. Поля: snils, surname, givenNames, middleName, birthDate.',
  bank_details:
    'Распознай реквизиты банковского счета на фото документа. ' +
    'Если на документе указаны ФИО владельца счета, тоже обязательно верни их. ' +
    NAME_CASE_INSTRUCTION +
    'Верни строго JSON без markdown и пояснений. Поля: bankAccountNumber, bankName, bik, corrAccount, inn, surname, givenNames, middleName.',
  visa:
    'Распознай визу на фото. ' +
    DATE_FORMAT_INSTRUCTION +
    'Верни строго JSON без markdown и пояснений. Поля: visaNumber, issueDate, expiryDate, surname, givenNames, nationality, birthDate.',
  insurance_policy:
    'Распознай страховой полис на фото. ' +
    "Найди номер полиса (обычно написано 'Серия' и 'Номер' или просто длинный номер в шапке документа) и дату начала действия полиса (поле 'с' в разделе 'Срок страхования'). " +
    DATE_FORMAT_INSTRUCTION +
    'Верни строго JSON без markdown и пояснений. Поля: policyNumber, issueDate.',
  registration_amina:
    'На изображении экран приложения или скриншот с данными регистрации сотрудника. ' +
    'Найди блоки с адресом проживания/регистрации и номером телефона. ' +
    "Если на экране есть поля 'Населенный пункт', 'Улица', 'Дом', 'Квартира', извлеки их отдельно и собери полный адрес в поле registrationAddress. " +
    'registrationAddress пиши по-русски, в человекочитаемом виде, без лишних комментариев. ' +
    'Телефон верни в поле phone в том виде, как он указан на экране, сохранив все цифры. ' +
    'Верни строго JSON без markdown и пояснений. Поля: registrationAddress, locality, street, house, apartment, phone.',
};

/** Второй «мягкий» запрос, если основной не вытащил ИНН/СНИЛС. */
export const FALLBACK_IDENTIFIER_PROMPTS: Record<'inn' | 'snils', string> = {
  inn:
    'Что видишь на изображении, ответь строго JSON без markdown. ' +
    'Если это документ ИНН, обязательно верни основной 12-значный номер документа в одном из ключей inn, documentNumber или document_number. ' +
    'Если видны ФИО и дата рождения, тоже верни их в JSON.',
  snils:
    'Что видишь на изображении, ответь строго JSON без markdown. ' +
    'Если это документ СНИЛС или АДИ-РЕГ, обязательно верни номер СНИЛС из 11 цифр в одном из ключей snils, documentNumber или document_number. ' +
    'Если видны ФИО и дата рождения, тоже верни их в JSON.',
};

let overridesCache: { value: Record<string, string>; expiresAt: number } | null = null;

export const invalidateHrOcrPromptsCache = (): void => {
  overridesCache = null;
};

const loadOverrides = async (): Promise<Record<string, string>> => {
  if (overridesCache && overridesCache.expiresAt > Date.now()) return overridesCache.value;
  let value: Record<string, string> = {};
  try {
    const raw = await settingsService.get(HR_OCR_PROMPTS_SETTING_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      value = Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>)
          .filter(([, v]) => typeof v === 'string' && v.trim())
          .map(([k, v]) => [k, String(v)]),
      );
    }
  } catch {
    value = overridesCache?.value ?? {};
  }
  overridesCache = { value, expiresAt: Date.now() + PROMPTS_CACHE_TTL_MS };
  return value;
};

export const resolvePrompt = async (type: HrOcrType): Promise<string> => {
  const overrides = await loadOverrides();
  return overrides[type]?.trim() || DEFAULT_PROMPTS[type];
};

export const resolveFallbackPrompt = async (type: 'inn' | 'snils'): Promise<string> => {
  const overrides = await loadOverrides();
  return overrides[`fallback_${type}`]?.trim() || FALLBACK_IDENTIFIER_PROMPTS[type];
};

export const getPromptsState = async (): Promise<{ defaults: Record<string, string>; overrides: Record<string, string> }> => ({
  defaults: { ...DEFAULT_PROMPTS, fallback_inn: FALLBACK_IDENTIFIER_PROMPTS.inn, fallback_snils: FALLBACK_IDENTIFIER_PROMPTS.snils },
  overrides: await loadOverrides(),
});

export const savePromptsOverrides = async (next: Record<string, unknown>, userId: string): Promise<void> => {
  const allowed = new Set<string>([...Object.keys(DEFAULT_PROMPTS), 'fallback_inn', 'fallback_snils']);
  const payload: Record<string, string> = {};
  for (const [key, value] of Object.entries(next)) {
    if (!allowed.has(key)) continue;
    const text = typeof value === 'string' ? value.trim() : '';
    if (text) payload[key] = text;
  }
  await settingsService.set(HR_OCR_PROMPTS_SETTING_KEY, JSON.stringify(payload), userId, 'Переопределения промптов OCR кадровых документов');
  invalidateHrOcrPromptsCache();
};
