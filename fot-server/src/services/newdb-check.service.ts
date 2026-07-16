/**
 * Проверки физлиц через newdb.net: РКЛ (реестр контролируемых лиц) и патент.
 *
 * ЕДИНСТВЕННОЕ место, где живёт знание о странностях API newdb: имена методов,
 * форматы дат, парсинг документов, маппинг статусов провайдера → наш UI-статус.
 * Контроллеры/UI не знают формата newdb. Первый реальный ответ подкручивается
 * здесь, без расползания логики.
 *
 * Стоимость/безопасность:
 *  - Валидация ПД ДО запроса: не шлём мусор в платный API.
 *  - Запись newdb_checks создаётся ДО вызова (request_sent=false), затем перед
 *    вызовом request_sent=true — аудит переживает обрыв/таймаут.
 *  - Анти-даблклик гейт считает только записи с request_sent=true.
 */
import { query, queryOne, execute } from '../config/postgres.js';
import { newdbBaseService, NewdbApiError } from './newdb-base.service.js';
import { citizenshipRequiresPatent } from './contractor-docs.service.js';
import { kickNewdbPendingPoller } from './newdb-pending-poller.service.js';

// Активные типы проверок. patent_mo зарезервирован в схеме БД, но НЕ вызывается
// (нужен ИНН физлица, которого в системе нет) — отвергается на входе.
// 'patent' — федеральный патент (метод провайдера foreign_patent): ищет по номеру
// патента + бланку, тогда как patent_msk — по паспорту в московском реестре.
export type CheckType = 'rkl' | 'patent_msk' | 'patent_mo' | 'patent';
export const ACTIVE_CHECK_TYPES: CheckType[] = ['rkl', 'patent_msk', 'patent'];

/** Типы, которые реально уходят провайдеру и участвуют в async-polling. */
export type PollableCheckType = 'rkl' | 'patent_msk' | 'patent';

/**
 * Имя метода в API newdb. Наш check_type 'patent' соответствует методу
 * `foreign_patent` — резолвим в одном месте, иначе повторный опрос queued-ответа
 * искал бы results.patent (поллер передаёт именно check_type).
 */
const providerMethodFor = (type: PollableCheckType): string =>
  type === 'patent' ? 'foreign_patent' : type;
export type CheckStatus = 'clean' | 'found' | 'invalid' | 'error' | 'not_applicable' | 'pending';

// Повторный платный запуск той же (pass, type) в пределах окна — отклоняем.
const ANTI_DOUBLE_WINDOW_MS = 30_000;

interface IPassDataRow {
  id: string;
  org_department_id: string;
  holder_name: string | null;
  birth_date: string | null;           // YYYY-MM-DD
  passport_series_number: string | null;
  passport_issue_date: string | null;  // YYYY-MM-DD
  citizenship: string | null;
  patent_number: string | null;
  patent_blank_number: string | null;
  has_residence_permit: boolean | null;
  residence_permit_number: string | null;
}

interface ICheckOutcome {
  status: CheckStatus;
  providerStatus: string | null;
  summary: string | null;
  raw: unknown;
  qid: string | null;
  balance: number | null;
  requestId: string | null;   // newdb requestId — для матчинга async-результата
  errorMessage: string | null;
  requestSent: boolean;
}

// ─── Утилиты парсинга (странности форматов — только тут) ────────────────────

/** Разбить ФИО: «Фамилия Имя Отчество…». Отчество опционально (остаток). */
export const splitFullName = (fullName: string | null | undefined): {
  lastName: string;
  firstName: string;
  secondName: string;
} => {
  const parts = (fullName || '').trim().split(/\s+/).filter(Boolean);
  return {
    lastName: parts[0] || '',
    firstName: parts[1] || '',
    secondName: parts.slice(2).join(' ') || '',
  };
};

// Кириллические двойники латиницы: в сериях иностранных паспортов операторы
// набирают визуально одинаковые буквы русской раскладкой (FК, FВ, РР…) —
// провайдер такие серии не находит.
const CYRILLIC_LOOKALIKES: Record<string, string> = {
  'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H',
  'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'У': 'Y', 'Х': 'X',
};

/**
 * Нормализовать строку паспорта из ручного ввода:
 *  - хвост « от DD.MM.YYYY…» отрезается, дата возвращается отдельно
 *    (фолбэк для issue_date, когда passport_issue_date не заполнен);
 *  - ведущая/хвостовая пунктуация убирается («FB1695900,»);
 *  - кириллические двойники латиницы транслитерируются.
 */
export const normalizePassport = (raw: string | null | undefined): { doc: string; issueDate: string | null } => {
  let s = (raw || '').trim();
  if (!s) return { doc: '', issueDate: null };

  let issueDate: string | null = null;
  const m = s.match(/\s+от\s+(\d{2}\.\d{2}\.\d{4}).*$/i);
  if (m && typeof m.index === 'number') {
    issueDate = m[1];
    s = s.slice(0, m.index);
  }

  s = s.replace(/^[\s,;.]+|[\s,;.]+$/g, '');
  s = s.replace(/[А-Яа-я]/g, (ch) => {
    const lat = CYRILLIC_LOOKALIKES[ch.toUpperCase()];
    if (!lat) return ch;
    return ch === ch.toUpperCase() ? lat : lat.toLowerCase();
  });

  return { doc: s, issueDate };
};

/**
 * Разбить документ на серию и номер. РФ-паспорт: ровно 10 цифр → серия=4, номер=6.
 * Иначе fallback: буквенный/пробельный префикс = серия, хвост цифр = номер.
 */
export const splitDocSeriaNumber = (raw: string | null | undefined): { seria: string; number: string } => {
  const cleaned = normalizePassport(raw).doc.replace(/\s+/g, '');
  if (!cleaned) return { seria: '', number: '' };

  const digitsOnly = cleaned.replace(/\D/g, '');
  if (/^\d+$/.test(cleaned) && digitsOnly.length === 10) {
    return { seria: digitsOnly.slice(0, 4), number: digitsOnly.slice(4) };
  }

  const m = cleaned.match(/^(.*?)(\d+)$/);
  if (m && m[2]) {
    return { seria: m[1] || '', number: m[2] };
  }
  return { seria: '', number: cleaned };
};

/**
 * Разбить номер патента/бланка на серию и номер.
 *
 * Форматы в системе (по факту прод-данных): патент — «77 №2400123456» (серия =
 * код региона, отделён знаком №), бланк — «ФМ1234567» / «7654321».
 * Своя функция, а НЕ splitDocSeriaNumber, по двум причинам:
 *  - тот убирает пробелы и отдал бы серию «77№» (знак № попадал бы в серию);
 *  - тот транслитерирует кириллицу (FК→FK) — для загранпаспорта верно, а у
 *    бланка серия кириллическая по-настоящему, её нельзя латинизировать.
 */
export const splitPatentDoc = (raw: string | null | undefined): { seria: string; number: string } => {
  const s = (raw ?? '').trim();
  if (!s) return { seria: '', number: '' };

  const withNo = s.match(/^(.*?)\s*№\s*(\d+)$/);
  if (withNo) return { seria: withNo[1].trim(), number: withNo[2] };

  const compact = s.replace(/\s+/g, '');
  const m = compact.match(/^(\D*)(\d+)$/);
  if (m && m[2]) return { seria: m[1], number: m[2] };
  return { seria: '', number: compact };
};

/** YYYY-MM-DD → DD.MM.YYYY (для РКЛ dob_info / issue_date). */
export const toDdMmYyyy = (iso: string | null | undefined): string => {
  if (!iso) return '';
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
};

/** Оставить YYYY-MM-DD (для патента dob). */
export const toYyyyMmDd = (iso: string | null | undefined): string => {
  if (!iso) return '';
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
};

// ─── Разбор ответа провайдера (sync/async) ──────────────────────────────────

interface IInterpreted {
  status: CheckStatus;
  providerStatus: string | null;
  summary: string | null;
  requestId: string | null;
  errorMessage: string | null;
}

/**
 * Единый разбор ответа newdb. Ключевое: ответ может быть АСИНХРОННЫМ —
 * `state:"queued"` без блока `results` (баланс уже списан). Такой ответ — НЕ
 * ошибка: помечаем `pending` и сохраняем `requestId` для будущего polling.
 * Только при `state:"complete"` c непустым `results[method]` парсим результат.
 *
 * Финальный `error` (не pending): errors_info (запрос отвергнут валидацией,
 * баланс не списан), явный state:"error", ошибка результата вне restart,
 * complete без данных. При state:"restart" провайдер сам повторяет задачу —
 * остаёмся pending, его ошибку показываем в summary.
 */
export const interpretNewdbResponse = (method: PollableCheckType, data: any): IInterpreted => {
  const state: string | null = data?.state ?? null;
  const requestId: string | null = data?.requestId ?? null;

  if (Array.isArray(data?.errors_info) && data.errors_info.length > 0) {
    const msg = data.errors_info.map((e: any) => e?.error).filter(Boolean).join('; ')
      || 'запрос отвергнут провайдером (errors_info)';
    return { status: 'error', providerStatus: 'errors_info', summary: null, requestId, errorMessage: msg };
  }

  // Ключ в results — имя метода провайдера, а не наш check_type ('patent' → foreign_patent).
  const result = data?.results?.[providerMethodFor(method)]?.result;
  const resultError: string | null = typeof result?.error === 'string' ? result.error : null;

  if (state === 'error') {
    return { status: 'error', providerStatus: state, summary: null, requestId, errorMessage: resultError || 'провайдер вернул state=error' };
  }
  if (resultError && state !== 'restart') {
    return { status: 'error', providerStatus: state, summary: null, requestId, errorMessage: `ошибка провайдера: ${resultError}` };
  }

  const item = result?.data?.[0];

  if (state === 'complete' && !item) {
    // complete без данных — ждать больше нечего, это не pending.
    return { status: 'error', providerStatus: state, summary: null, requestId, errorMessage: 'провайдер вернул complete без результата' };
  }

  if (state !== 'complete') {
    // queued / processing / restart / нет результата — ждём (часики), не ошибка.
    const summary = state === 'restart' && resultError
      ? `Провайдер повторяет проверку: ${resultError}`
      : 'В обработке (запрос принят)';
    return { status: 'pending', providerStatus: state, summary, requestId, errorMessage: null };
  }

  if (method === 'rkl') {
    const registryStatus: string | null = item?.registry_status ?? null;
    let status: CheckStatus;
    if (registryStatus === 'not_found') status = 'clean';
    else if (registryStatus === 'found') status = 'found';
    else status = 'error'; // unknown — сырой смысл сохраняем в providerStatus
    return { status, providerStatus: registryStatus, summary: item?.title ?? null, requestId, errorMessage: null };
  }

  if (method === 'patent') {
    // Федеральный патент (foreign_patent) — статус в doc_status, свободной строкой.
    // ПОРЯДОК КРИТИЧЕН: негатив проверяем ПЕРВЫМ, иначе «не действителен» /
    // «недействителен» поймались бы на подстроку «действ» и стали бы clean.
    const docStatus: string | null = item?.doc_status ?? null;
    const n = (docStatus || '').toLowerCase().replace(/ё/g, 'е');
    let status: CheckStatus;
    if (!n) status = 'error';
    else if (n.includes('не действ') || n.includes('недейств') || n.includes('аннул') || n.includes('не найден')) status = 'invalid';
    else if (n.includes('действ') || n.includes('оформлен')) status = 'clean';
    else status = 'error'; // неизвестная формулировка — не трактуем как «чисто»/«плохо»
    return { status, providerStatus: docStatus, summary: docStatus, requestId, errorMessage: null };
  }

  // patent_msk — консервативный маппинг: неизвестный статус → error.
  const docStatus: string | null = item?.status ?? null;
  const message: string | null = item?.message ?? null;
  const n = (docStatus || '').toLowerCase();
  let status: CheckStatus;
  if (n === 'valid' || n === 'active' || n.includes('действ')) status = 'clean';
  else if (n === 'expired' || n === 'not_found' || n === 'annulled' || n.includes('аннул') || n.includes('истёк') || n.includes('истек')) status = 'invalid';
  else status = 'error'; // спорный/неизвестный статус — не трактуем как «чисто»/«плохо»
  return { status, providerStatus: docStatus, summary: message ?? docStatus, requestId, errorMessage: null };
};

/**
 * Сводный статус патента из московской и федеральной проверок.
 *
 * Принцип: clean выигрывает всегда; invalid допустим ТОЛЬКО когда все применимые
 * завершённые проверки отрицательны. Любая неопределённость (error/found/не
 * проверено) не должна давать ложный ❌ — это и была исходная проблема.
 */
export const combinePatentStatus = (
  msk: CheckStatus | null,
  rf: CheckStatus | null,
): CheckStatus | null => {
  const vals: (CheckStatus | null)[] = [msk, rf];
  if (vals.includes('clean')) return 'clean';
  if (vals.includes('pending')) return 'pending';
  // found — старый способ записи неизвестного ответа foreign_patent (строки живы
  // с миграции 212): считаем неопределённостью, а не отрицательным результатом.
  if (vals.some(v => v === 'error' || v === 'found')) return 'error';
  if (vals.includes(null)) return null;            // проверено НЕ полностью
  if (vals.includes('invalid')) return 'invalid';  // все применимые завершены и ❌
  return 'not_applicable';                         // оба n/a
};

// ─── Валидация + вызовы ─────────────────────────────────────────────────────

/** Пометить request_sent=true РОВНО перед внешним вызовом (аудит переживает обрыв). */
const markSent = async (checkId: string): Promise<void> => {
  await execute(`UPDATE newdb_checks SET request_sent = true WHERE id = $1::uuid`, [checkId]);
};

// РКЛ (реестр контролируемых лиц МВД) содержит только иностранцев.
const isRussianCitizenship = (c: string | null | undefined): boolean => {
  const n = (c || '').trim().toUpperCase();
  return n === 'РОССИЯ' || n === 'РФ' || n === 'РОССИЙСКАЯ ФЕДЕРАЦИЯ';
};

// Гражданство, по которому нельзя судить о патенте: не заполнено или «Другое».
const isUnknownCitizenship = (c: string | null | undefined): boolean => {
  const n = (c || '').trim().toUpperCase();
  return n === '' || n === 'ДРУГОЕ';
};

const runRkl = async (pass: IPassDataRow, taskId: string, checkId: string): Promise<ICheckOutcome> => {
  if (isRussianCitizenship(pass.citizenship)) {
    return { status: 'not_applicable', providerStatus: null, summary: 'РКЛ не применим: гражданство РФ', raw: null, qid: null, balance: null, requestId: null, requestSent: false, errorMessage: null };
  }

  const { lastName, firstName, secondName } = splitFullName(pass.holder_name);
  const { seria, number } = splitDocSeriaNumber(pass.passport_series_number);
  const dob = toDdMmYyyy(pass.birth_date);
  // Дата выдачи: из поля, а при его пустоте — из хвоста «… от DD.MM.YYYY»
  // в строке паспорта (частый способ ручного ввода).
  const issueDate = toDdMmYyyy(pass.passport_issue_date)
    || normalizePassport(pass.passport_series_number).issueDate
    || '';

  const missing: string[] = [];
  if (!lastName || !firstName) missing.push('ФИО');
  if (!dob) missing.push('дата рождения');
  if (!number) missing.push('номер паспорта');
  if (!issueDate) missing.push('дата выдачи паспорта');
  if (missing.length) {
    return { status: 'error', providerStatus: null, summary: null, raw: null, qid: null, balance: null, requestId: null, requestSent: false, errorMessage: `Недостаточно данных для РКЛ: ${missing.join(', ')}` };
  }

  // Опциональные поля с пустым значением НЕ отправляем: провайдер отвечает
  // 400 «… must be non-empty» на пустую строку (наблюдалось для id_doc_seria).
  const params: Record<string, string> = {
    method: 'rkl',
    country: 'ru',
    lastname: lastName,
    firstname: firstName,
    dob_info: dob,
    issue_date: issueDate,
    id_doc_number: number,
    taskId,
  };
  if (secondName) params.secondname = secondName;
  if (seria) params.id_doc_seria = seria;

  await markSent(checkId);
  const data = await newdbBaseService.post<any>({ params });
  const r = interpretNewdbResponse('rkl', data);
  return {
    status: r.status,
    providerStatus: r.providerStatus,
    summary: r.summary,
    raw: data,
    qid: data?.params?.params?.newdb_qid ?? data?.params?.newdb_qid ?? null,
    balance: typeof data?.balance === 'number' ? data.balance : null,
    requestId: r.requestId,
    errorMessage: r.errorMessage,
    requestSent: true,
  };
};

// Патент Москва (patent_msk): проверка по паспорту (удостоверение личности) +
// гражданство. Патент/бланк НЕ нужны. taskId в этом методе не участвует.
const runPatentMsk = async (pass: IPassDataRow, _taskId: string, checkId: string): Promise<ICheckOutcome> => {
  // «Не требуется» — только когда гражданство ИЗВЕСТНО и непатентное, либо ВНЖ.
  // Пустое/«Другое» гражданство — проверяем без параметра citizenship: провайдер
  // тогда сам ищет патент по трём странам (Узбекистан/Таджикистан/Кыргызстан).
  const citizenshipKnown = !isUnknownCitizenship(pass.citizenship);
  if (citizenshipKnown && !citizenshipRequiresPatent(pass.citizenship)) {
    return { status: 'not_applicable', providerStatus: null, summary: 'Патент не требуется: гражданство РФ или непатентное', raw: null, qid: null, balance: null, requestId: null, requestSent: false, errorMessage: null };
  }
  if (pass.has_residence_permit) {
    return { status: 'not_applicable', providerStatus: null, summary: 'Патент не требуется: указан ВНЖ', raw: null, qid: null, balance: null, requestId: null, requestSent: false, errorMessage: null };
  }

  const id = splitDocSeriaNumber(pass.passport_series_number);
  const missing: string[] = [];
  if (!id.number) missing.push('паспорт');
  // Серия для patent_msk обязательна (провайдер: «Отсутствует обязательный
  // параметр: id_doc_seria») — без неё платный вызов бессмысленен.
  if (id.number && !id.seria) missing.push('серия паспорта');
  if (missing.length) {
    return { status: 'error', providerStatus: null, summary: null, raw: null, qid: null, balance: null, requestId: null, requestSent: false, errorMessage: `Недостаточно данных для патента (Москва): ${missing.join(', ')}` };
  }

  // Пустые опциональные поля не отправляем (400 «… must be non-empty»).
  const params: Record<string, string> = {
    method: 'patent_msk',
    id_doc_number: id.number,
    country: 'ru',
  };
  if (id.seria) params.id_doc_seria = id.seria;
  if (citizenshipKnown && pass.citizenship) params.citizenship = pass.citizenship.trim();

  await markSent(checkId);
  const data = await newdbBaseService.post<any>({ params });
  const r = interpretNewdbResponse('patent_msk', data);
  return {
    status: r.status,
    providerStatus: r.providerStatus,
    summary: r.summary,
    raw: data,
    qid: data?.params?.newdb_qid ?? null,
    balance: typeof data?.balance === 'number' ? data.balance : null,
    requestId: r.requestId,
    errorMessage: r.errorMessage,
    requestSent: true,
  };
};

/**
 * Федеральный патент (method=foreign_patent). В отличие от patent_msk ищет НЕ по
 * паспорту в московском реестре, а по номеру патента + бланку (плюс ФИО/ДР/паспорт).
 * Поэтому у работника с истёкшим московским патентом здесь может быть «действителен».
 * Контракт параметров — как в первой реализации (коммит c0d3bfaf).
 */
const runPatentFederal = async (pass: IPassDataRow, _taskId: string, checkId: string): Promise<ICheckOutcome> => {
  const na = (summary: string): ICheckOutcome =>
    ({ status: 'not_applicable', providerStatus: null, summary, raw: null, qid: null, balance: null, requestId: null, requestSent: false, errorMessage: null });

  // Применимость — как в runPatentMsk.
  const citizenshipKnown = !isUnknownCitizenship(pass.citizenship);
  if (citizenshipKnown && !citizenshipRequiresPatent(pass.citizenship)) {
    return na('Патент не требуется: гражданство РФ или непатентное');
  }
  if (pass.has_residence_permit) return na('Патент не требуется: указан ВНЖ');

  const { lastName, firstName, secondName } = splitFullName(pass.holder_name);
  const id = splitDocSeriaNumber(pass.passport_series_number);
  const doc = splitPatentDoc(pass.patent_number);
  const blank = splitPatentDoc(pass.patent_blank_number);
  const dob = toYyyyMmDd(pass.birth_date);

  // Полная валидация контракта ДО платного вызова. Номер патента и бланк —
  // раздельно: это разные поля карточки, и правит их пользователь по-разному.
  //
  // Серии: провайдер требует id_doc_seria и blank_seria (наблюдалось «Отсутствует
  // обязательный параметр: blank_seria»). Пустые поля мы не шлём, поэтому без
  // серии запрос заведомо отвергается — ловим локально, с понятным текстом.
  // doc_seria не проверяем: все патенты хранятся как «77 №…», серия есть всегда.
  const missing: string[] = [];
  if (!lastName || !firstName) missing.push('ФИО');
  if (!dob) missing.push('дата рождения');
  if (!id.number) missing.push('номер паспорта');
  if (id.number && !id.seria) missing.push('серия паспорта');
  if (!doc.number) missing.push('номер патента');
  if (!blank.number) missing.push('бланк патента');
  if (blank.number && !blank.seria) missing.push('серия бланка патента');
  if (missing.length) {
    return { status: 'error', providerStatus: null, summary: null, raw: null, qid: null, balance: null, requestId: null, requestSent: false, errorMessage: `Недостаточно данных для патента (РФ): ${missing.join(', ')}` };
  }

  // Пустые опциональные поля не отправляем (провайдер: 400 «… must be non-empty»).
  const params: Record<string, string> = {
    method: 'foreign_patent',
    doctype: 'patent',
    country: 'ru',
    lastname: lastName,
    firstname: firstName,
    dob,
    id_doc_number: id.number,
    doc_number: doc.number,
    blank_number: blank.number,
  };
  if (secondName) params.secondname = secondName;
  if (id.seria) params.id_doc_seria = id.seria;
  if (doc.seria) params.doc_seria = doc.seria;
  if (blank.seria) params.blank_seria = blank.seria;

  await markSent(checkId);
  const data = await newdbBaseService.post<any>({ params });
  const r = interpretNewdbResponse('patent', data);
  return {
    status: r.status,
    providerStatus: r.providerStatus,
    summary: r.summary,
    raw: data,
    qid: data?.params?.newdb_qid ?? null,
    balance: typeof data?.balance === 'number' ? data.balance : null,
    requestId: r.requestId,
    errorMessage: r.errorMessage,
    requestSent: true,
  };
};

// ─── Публичное API сервиса ──────────────────────────────────────────────────

export interface INewdbCheckResult {
  id: string;
  check_type: CheckType;
  status: CheckStatus;
  request_sent: boolean;
  provider_status: string | null;
  result_summary: string | null;
  error_message: string | null;
  balance: number | null;
  created_at: string;
}

const getPassData = async (passId: string): Promise<IPassDataRow | null> =>
  queryOne<IPassDataRow>(
    `SELECT p.id,
            p.org_department_id,
            COALESCE(h.holder_name, p.holder_name) AS holder_name,
            to_char(p.birth_date, 'YYYY-MM-DD') AS birth_date,
            p.passport_series_number,
            to_char(p.passport_issue_date, 'YYYY-MM-DD') AS passport_issue_date,
            p.citizenship,
            p.patent_number,
            p.patent_blank_number,
            p.has_residence_permit,
            p.residence_permit_number
       FROM contractor_passes p
       LEFT JOIN contractor_pass_holders h ON h.pass_id = p.id AND h.valid_until IS NULL
      WHERE p.id = $1::uuid`,
    [passId],
  );

// Сколько ждём результата async-проверки, прежде чем счесть её умершей.
const PENDING_TTL_HOURS = 24;

/**
 * Явно закрыть просроченные pending (старше TTL) как timeout-ошибку — ПЕРЕД
 * новым платным запуском. История исправляется, а не просто перестаёт
 * учитываться: «вечный» pending иначе навсегда останется ложными часиками.
 */
const closeExpiredPending = async (passId: string, type: CheckType): Promise<void> => {
  await execute(
    `UPDATE newdb_checks
        SET status = 'error',
            error_message = 'истёк срок ожидания результата (timeout ${PENDING_TTL_HOURS} ч)'
      WHERE contractor_pass_id = $1::uuid AND check_type = $2 AND status = 'pending'
        AND created_at <= now() - interval '${PENDING_TTL_HOURS} hours'`,
    [passId, type],
  );
};

/**
 * Блокировать повторный платный запуск. Учитываем и request_sent=true (недавно
 * отправленный), и status='pending' (queued-запись висит в обработке) — иначе
 * можно насоздавать платных дублей поверх незавершённого async-запроса.
 * pending блокирует в пределах TTL (просроченные закрывает closeExpiredPending;
 * фильтр по возрасту здесь — страховка от гонок); отправленные — окно.
 */
const hasBlockingCheck = async (passId: string, type: CheckType): Promise<boolean> => {
  const pendingRow = await queryOne<{ id: string }>(
    `SELECT id FROM newdb_checks
      WHERE contractor_pass_id = $1::uuid AND check_type = $2 AND status = 'pending'
        AND created_at > now() - interval '${PENDING_TTL_HOURS} hours'
      LIMIT 1`,
    [passId, type],
  );
  if (pendingRow) return true;

  const row = await queryOne<{ created_at: string }>(
    `SELECT created_at FROM newdb_checks
      WHERE contractor_pass_id = $1::uuid AND check_type = $2 AND request_sent = true
      ORDER BY created_at DESC LIMIT 1`,
    [passId, type],
  );
  if (!row) return false;
  return Date.now() - new Date(row.created_at).getTime() < ANTI_DOUBLE_WINDOW_MS;
};

/**
 * Запустить проверки для одного пропуска. Жизненный цикл записи:
 * INSERT (request_sent=false) → валидация/вызов → UPDATE результата.
 */
export const runChecksForPass = async (
  passId: string,
  types: CheckType[],
  userId: string,
): Promise<INewdbCheckResult[]> => {
  const pass = await getPassData(passId);
  if (!pass) throw new NewdbApiError('Пропуск не найден', 404);

  const results: INewdbCheckResult[] = [];

  for (const type of types) {
    if (type === 'patent_mo') {
      throw new NewdbApiError('Патент МО пока не поддерживается: нужен ИНН физлица', 400);
    }
    await closeExpiredPending(passId, type);
    if (await hasBlockingCheck(passId, type)) {
      throw new NewdbApiError(`Проверка ${type} уже выполняется/выполнялась только что — подождите`, 429);
    }

    // 1. INSERT снимок ПД, request_sent=false
    const inserted = await queryOne<{ id: string; created_at: string }>(
      `INSERT INTO newdb_checks
         (created_by, check_type, subject_kind, contractor_pass_id, org_department_id,
          full_name, birth_date, passport_series_number, patent_number, patent_blank_number,
          citizenship, status)
       VALUES ($1::uuid, $2, 'contractor_pass', $3::uuid, $4::uuid,
               $5, NULLIF($6,'')::date, $7, $8, $9, $10, 'error')
       RETURNING id, created_at`,
      [userId, type, passId, pass.org_department_id, pass.holder_name,
        pass.birth_date, pass.passport_series_number, pass.patent_number,
        pass.patent_blank_number, pass.citizenship],
    );
    if (!inserted) throw new NewdbApiError('Не удалось создать запись проверки', 500);
    const checkId = inserted.id;
    const taskId = `${checkId}-${type}`;

    let outcome: ICheckOutcome;
    try {
      // Валидация внутри run; при успехе run сам метит request_sent=true
      // (markSent) ровно перед внешним вызовом — обрыв остаётся в аудите.
      // Явный switch: с тремя типами тернарник молча слал бы всё не-rkl в Москву.
      const run =
        type === 'rkl' ? runRkl
        : type === 'patent_msk' ? runPatentMsk
        : runPatentFederal; // 'patent'; patent_mo отклонён выше
      outcome = await run(pass, taskId, checkId);
    } catch (error) {
      // markSent (если дошли до вызова) уже выставил request_sent=true в БД;
      // если упали до вызова (напр. токен не задан) — там false. Не трогаем
      // request_sent в UPDATE, читаем фактическое значение через RETURNING.
      const apiErr = error instanceof NewdbApiError ? error : new NewdbApiError(error instanceof Error ? error.message : String(error), 0);
      outcome = { status: 'error', providerStatus: null, summary: null, raw: null, qid: null, balance: null, requestId: null, requestSent: false, errorMessage: `Ошибка newdb (${apiErr.status}): ${apiErr.message}` };
    }

    // 3. UPDATE результата (request_sent не трогаем — им владеет markSent)
    const updated = await queryOne<{ request_sent: boolean }>(
      `UPDATE newdb_checks
          SET status = $2, newdb_task_id = $3,
              provider_status = $4, result_summary = $5, raw_response = $6::jsonb,
              newdb_qid = $7, balance = $8, error_message = $9, newdb_request_id = $10
        WHERE id = $1::uuid
      RETURNING request_sent`,
      [checkId, outcome.status, taskId, outcome.providerStatus,
        outcome.summary, outcome.raw != null ? JSON.stringify(outcome.raw) : null,
        outcome.qid, outcome.balance, outcome.errorMessage, outcome.requestId],
    );

    results.push({
      id: checkId,
      check_type: type,
      status: outcome.status,
      request_sent: updated?.request_sent ?? false,
      provider_status: outcome.providerStatus,
      result_summary: outcome.summary,
      error_message: outcome.errorMessage,
      balance: outcome.balance,
      created_at: inserted.created_at,
    });
  }

  // Запрос принят в очередь провайдера — ускоряем фоновый добор результата,
  // чтобы часики исчезали без ручного «Обновить».
  if (results.some(r => r.status === 'pending')) {
    kickNewdbPendingPoller();
  }

  return results;
};

export const BULK_LIMIT = 15;

export interface IBulkItemResult {
  passId: string;
  results?: INewdbCheckResult[];
  error?: string;
}

/**
 * Массовый прогон: серверная валидация passIds (не доверяем фронту),
 * последовательное выполнение (платно + rate-limit), ошибка одного пропуска
 * не роняет остальные. Лимит BULK_LIMIT против HTTP-таймаута.
 */
export const runChecksBulk = async (
  passIds: string[],
  types: CheckType[],
  userId: string,
): Promise<{ items: IBulkItemResult[]; skipped: string[] }> => {
  const unique = [...new Set(passIds)];
  if (unique.length > BULK_LIMIT) {
    throw new NewdbApiError(`Слишком много пропусков за раз (макс ${BULK_LIMIT}). Сузьте выбор.`, 400);
  }

  // Валидируем на сервере: существуют, не revoked, есть ФИО.
  const valid = await query<{ id: string }>(
    `SELECT p.id
       FROM contractor_passes p
       LEFT JOIN contractor_pass_holders h ON h.pass_id = p.id AND h.valid_until IS NULL
      WHERE p.id = ANY($1::uuid[])
        AND p.status <> 'revoked'
        AND NULLIF(trim(COALESCE(h.holder_name, p.holder_name)), '') IS NOT NULL`,
    [unique],
  );
  const validIds = new Set(valid.map(r => r.id));
  const skipped = unique.filter(id => !validIds.has(id));

  const items: IBulkItemResult[] = [];
  for (const passId of unique) {
    if (!validIds.has(passId)) continue;
    try {
      const results = await runChecksForPass(passId, types, userId);
      items.push({ passId, results });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      items.push({ passId, error: msg });
    }
  }

  return { items, skipped };
};

interface IPassListRow {
  id: string;
  pass_number: string;
  holder_name: string | null;
  citizenship: string | null;
  passport_series_number: string | null;
  patent_number: string | null;
  has_residence_permit: boolean | null;
  last_rkl_status: CheckStatus | null;
  last_rkl_at: string | null;
  last_rkl_summary: string | null;
  last_patent_msk_status: CheckStatus | null;
  last_patent_msk_at: string | null;
  last_patent_msk_summary: string | null;
  last_patent_rf_status: CheckStatus | null;
  last_patent_rf_at: string | null;
  last_patent_rf_summary: string | null;
  // Сводный итог по патенту (Москва + федеральный). at/summary — от источника,
  // определившего итог; для null-итога даты нет.
  last_patent_overall_status: CheckStatus | null;
  last_patent_overall_at: string | null;
  last_patent_overall_summary: string | null;
}

/** Строка БД до расчёта сводного статуса. */
type IPassListDbRow = Omit<
  IPassListRow,
  'last_patent_overall_status' | 'last_patent_overall_at' | 'last_patent_overall_summary'
>;

/**
 * Достроить сводный статус патента к строке списка. at/summary берём от источника,
 * который определил итог (напр. итог clean от РФ → дата и текст РФ), чтобы в UI
 * дата не расходилась с показанной причиной.
 */
const withOverallPatent = (r: IPassListDbRow): IPassListRow => {
  const status = combinePatentStatus(r.last_patent_msk_status, r.last_patent_rf_status);
  const mskDecides = r.last_patent_msk_status === status;
  const rfDecides = r.last_patent_rf_status === status;
  const at = status === null ? null : mskDecides ? r.last_patent_msk_at : rfDecides ? r.last_patent_rf_at : null;
  const summary = status === null ? null : mskDecides ? r.last_patent_msk_summary : rfDecides ? r.last_patent_rf_summary : null;
  return { ...r, last_patent_overall_status: status, last_patent_overall_at: at, last_patent_overall_summary: summary };
};

/** Пропуска отдела (со вложенными subtree) + раздельные последние статусы + сводный. */
export const listPassesForDepartment = async (orgDepartmentId: string): Promise<IPassListRow[]> =>
  query<IPassListDbRow>(
    `WITH subtree AS (
       SELECT id FROM public.get_descendant_department_ids(ARRAY[$1::uuid])
     )
     SELECT p.id,
            p.pass_number,
            COALESCE(h.holder_name, p.holder_name) AS holder_name,
            p.citizenship,
            p.passport_series_number,
            p.patent_number,
            p.has_residence_permit,
            rkl.status  AS last_rkl_status,
            rkl.created_at AS last_rkl_at,
            rkl.result_summary AS last_rkl_summary,
            pat.status  AS last_patent_msk_status,
            pat.created_at AS last_patent_msk_at,
            pat.result_summary AS last_patent_msk_summary,
            prf.status  AS last_patent_rf_status,
            prf.created_at AS last_patent_rf_at,
            prf.result_summary AS last_patent_rf_summary
       FROM contractor_passes p
       LEFT JOIN contractor_pass_holders h ON h.pass_id = p.id AND h.valid_until IS NULL
       LEFT JOIN LATERAL (
         SELECT status, created_at,
                COALESCE(result_summary, error_message) AS result_summary
           FROM newdb_checks c
          WHERE c.contractor_pass_id = p.id AND c.check_type = 'rkl'
          ORDER BY c.created_at DESC LIMIT 1
       ) rkl ON true
       LEFT JOIN LATERAL (
         SELECT status, created_at,
                COALESCE(result_summary, error_message) AS result_summary
           FROM newdb_checks c
          WHERE c.contractor_pass_id = p.id AND c.check_type = 'patent_msk'
          ORDER BY c.created_at DESC LIMIT 1
       ) pat ON true
       LEFT JOIN LATERAL (
         SELECT status, created_at,
                COALESCE(result_summary, error_message) AS result_summary
           FROM newdb_checks c
          WHERE c.contractor_pass_id = p.id AND c.check_type = 'patent'
          ORDER BY c.created_at DESC LIMIT 1
       ) prf ON true
      WHERE p.org_department_id IN (SELECT id FROM subtree)
        AND p.status <> 'revoked'
        AND NULLIF(trim(COALESCE(h.holder_name, p.holder_name)), '') IS NOT NULL
      ORDER BY p.pass_number ASC`,
    [orgDepartmentId],
  ).then(rows => rows.map(withOverallPatent));

export interface IContractorOrg {
  id: string;
  name: string;
  with_fio: number;
  total: number;
}

/**
 * Подрядные организации с ≥1 сотрудником с ФИО (для селектора вкладки «Проверки»).
 * Скоуп — ветка «Подрядные организации» (get_descendant_department_ids от неё);
 * если узел не найден — фолбэк на все org с contractor_passes (не отдать пусто).
 */
export const listContractorOrgs = async (): Promise<IContractorOrg[]> =>
  query<IContractorOrg>(
    `WITH contractor_root AS (
       SELECT id FROM public.org_departments
        WHERE name = 'Подрядные организации' AND parent_id IS NOT NULL
        LIMIT 1
     ),
     scope AS (
       SELECT id FROM public.get_descendant_department_ids(
         ARRAY(SELECT id FROM contractor_root)::uuid[]
       )
     )
     SELECT od.id, od.name,
            count(DISTINCT p.id) FILTER (
              WHERE NULLIF(trim(COALESCE(h.holder_name, p.holder_name)), '') IS NOT NULL
            )::int AS with_fio,
            count(DISTINCT p.id)::int AS total
       FROM contractor_passes p
       JOIN org_departments od ON od.id = p.org_department_id
       LEFT JOIN contractor_pass_holders h ON h.pass_id = p.id AND h.valid_until IS NULL
      WHERE p.status <> 'revoked'
        AND (
          NOT EXISTS (SELECT 1 FROM contractor_root)   -- фолбэк: узел не найден
          OR p.org_department_id IN (SELECT id FROM scope)
        )
      GROUP BY od.id, od.name
     HAVING count(DISTINCT p.id) FILTER (
              WHERE NULLIF(trim(COALESCE(h.holder_name, p.holder_name)), '') IS NOT NULL
            ) > 0
      ORDER BY with_fio DESC, od.name ASC`,
  );

/** История проверок пропуска (без raw_response). */
export const getResultsForPass = async (passId: string): Promise<INewdbCheckResult[]> =>
  query<INewdbCheckResult>(
    `SELECT id, check_type, status, request_sent, provider_status,
            result_summary, error_message, balance, created_at
       FROM newdb_checks
      WHERE contractor_pass_id = $1::uuid
      ORDER BY created_at DESC LIMIT 100`,
    [passId],
  );

/** Сырой ответ одной проверки (ПДн — только edit-доступ). */
export const getRawResponse = async (checkId: string): Promise<unknown | null> => {
  const row = await queryOne<{ raw_response: unknown }>(
    `SELECT raw_response FROM newdb_checks WHERE id = $1::uuid`,
    [checkId],
  );
  return row?.raw_response ?? null;
};

// ─── Polling: забор результата queued-проверки по requestId ──────────────────

const POLL_LIMIT = BULK_LIMIT;

export interface IRefreshSummary {
  updated: number;      // получен финальный результат
  stillPending: number; // проверено, но всё ещё в обработке
  errors: number;       // сетевая/API ошибка при попытке (осталось pending)
  skipped: number;      // pending без requestId — обновить нечем
}

interface IPendingRow {
  id: string;
  check_type: PollableCheckType;
  newdb_request_id: string | null;
  saved_raw: any;
}

/** Типы, участвующие в async-polling — единый список для всех SQL-выборок. */
const POLLABLE_TYPES_SQL = `('rkl', 'patent_msk', 'patent')`;

/**
 * Опросить одну pending-проверку: повторный POST того же метода с тем же
 * requestId (polling по доке newdb — is_repeat, без нового списания).
 * Тело берём из сохранённых raw_response.params (ровно то, что newdb принял).
 * Возвращает исход для сводки.
 */
const pollPending = async (row: IPendingRow): Promise<'updated' | 'stillPending' | 'error' | 'skipped'> => {
  // Сначала перечитываем СОХРАНЁННЫЙ ответ: если он уже финальный (errors_info,
  // state=error…) — запись зависла из-за старой классификации. Завершаем
  // локально, провайдера не трогаем (опрашивать нечего, запрос не был принят).
  const saved = interpretNewdbResponse(row.check_type, row.saved_raw);
  if (saved.status !== 'pending') {
    await execute(
      `UPDATE newdb_checks
          SET status = $2, provider_status = $3, result_summary = $4, error_message = $5
        WHERE id = $1::uuid`,
      [row.id, saved.status, saved.providerStatus, saved.summary, saved.errorMessage?.slice(0, 500) ?? null],
    );
    return 'updated';
  }

  const savedParams = row.saved_raw?.params ?? null;
  if (!row.newdb_request_id || !savedParams) {
    // Опросить невозможно НИКОГДА (нечем матчить результат) — закрываем
    // ошибкой, иначе запись вечно занимает лимит выборки поллера.
    await execute(
      `UPDATE newdb_checks
          SET status = 'error', error_message = 'невозможно обновить: нет requestId'
        WHERE id = $1::uuid`,
      [row.id],
    );
    return 'skipped';
  }

  const body = { params: savedParams, requestId: row.newdb_request_id };

  let data: any;
  try {
    data = await newdbBaseService.post<any>(body);
  } catch (error) {
    // Сетевая/таймаут/5xx — НЕ ошибка результата: оставляем pending, метим попытку.
    const msg = error instanceof Error ? error.message : String(error);
    await execute(
      `UPDATE newdb_checks SET error_message = $2 WHERE id = $1::uuid`,
      [row.id, `последняя попытка обновления не удалась: ${msg}`.slice(0, 500)],
    );
    return 'error';
  }

  const r = interpretNewdbResponse(row.check_type, data);
  const balance = typeof data?.balance === 'number' ? data.balance : null;

  if (r.status === 'pending') {
    // Всё ещё в очереди — статус не трогаем; summary сохраняем (причина
    // restart должна дойти до тултипа в UI).
    await execute(
      `UPDATE newdb_checks
          SET raw_response = $2::jsonb, provider_status = $3, result_summary = $4,
              balance = COALESCE($5, balance), error_message = NULL
        WHERE id = $1::uuid`,
      [row.id, JSON.stringify(data), r.providerStatus, r.summary, balance],
    );
    return 'stillPending';
  }

  // Финальный результат (error_message не затираем NULL'ом — там причина).
  await execute(
    `UPDATE newdb_checks
        SET status = $2, provider_status = $3, result_summary = $4,
            raw_response = $5::jsonb, balance = COALESCE($6, balance), error_message = $7
      WHERE id = $1::uuid`,
    [row.id, r.status, r.providerStatus, r.summary, JSON.stringify(data), balance, r.errorMessage?.slice(0, 500) ?? null],
  );
  return 'updated';
};

/** Обновить все pending-проверки пропуска через polling. Последовательно, с лимитом. */
export const refreshPendingForPass = async (passId: string): Promise<IRefreshSummary> => {
  const rows = await query<IPendingRow>(
    `SELECT id, check_type, newdb_request_id, raw_response AS saved_raw
       FROM newdb_checks
      WHERE contractor_pass_id = $1::uuid AND status = 'pending'
        AND check_type IN ${POLLABLE_TYPES_SQL}
      ORDER BY created_at ASC
      LIMIT ${POLL_LIMIT}`,
    [passId],
  );

  const summary: IRefreshSummary = { updated: 0, stillPending: 0, errors: 0, skipped: 0 };
  for (const row of rows) {
    const outcome = await pollPending(row);
    if (outcome === 'updated') summary.updated++;
    else if (outcome === 'stillPending') summary.stillPending++;
    else if (outcome === 'error') summary.errors++;
    else summary.skipped++;
  }
  return summary;
};

/**
 * Глобальный обход pending-проверок для фонового поллера.
 *
 * Порядок важен: сначала закрываем просроченные (>TTL) как timeout — иначе
 * выборка `ORDER BY created_at ASC LIMIT n` навсегда застрянет на мёртвых
 * старых строках и свежие проверки до polling не дойдут (TTL-очистка в
 * runChecksForPass срабатывает только перед новым платным запуском по
 * конкретному пропуску).
 */
export const pollAllPending = async (limit = POLL_LIMIT): Promise<IRefreshSummary> => {
  await execute(
    `UPDATE newdb_checks
        SET status = 'error',
            error_message = 'истёк срок ожидания результата (timeout ${PENDING_TTL_HOURS} ч)'
      WHERE status = 'pending' AND check_type IN ${POLLABLE_TYPES_SQL}
        AND created_at <= now() - interval '${PENDING_TTL_HOURS} hours'`,
  );

  const rows = await query<IPendingRow>(
    `SELECT id, check_type, newdb_request_id, raw_response AS saved_raw
       FROM newdb_checks
      WHERE status = 'pending' AND check_type IN ${POLLABLE_TYPES_SQL}
      ORDER BY created_at ASC
      LIMIT $1`,
    [limit],
  );

  const summary: IRefreshSummary = { updated: 0, stillPending: 0, errors: 0, skipped: 0 };
  for (const row of rows) {
    const outcome = await pollPending(row);
    if (outcome === 'updated') summary.updated++;
    else if (outcome === 'stillPending') summary.stillPending++;
    else if (outcome === 'error') summary.errors++;
    else summary.skipped++;
  }
  return summary;
};
