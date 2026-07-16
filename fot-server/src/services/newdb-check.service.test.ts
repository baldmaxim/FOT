/**
 * Тесты проверок newdb (РКЛ/патент): парсинг паспортов на реальных прод-кейсах,
 * классификация ответов провайдера (errors_info / restart / state=error /
 * complete без данных) и поведенческие сценарии — что НЕ уходит во внешний
 * платный API и что реально попадает в body запроса.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../config/postgres.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock('./newdb-base.service.js', () => {
  class NewdbApiError extends Error {
    status: number;
    code?: string;
    constructor(message: string, status: number, code?: string) {
      super(message);
      this.name = 'NewdbApiError';
      this.status = status;
      this.code = code;
    }
  }
  return { NewdbApiError, newdbBaseService: { post: vi.fn() } };
});

vi.mock('./newdb-pending-poller.service.js', () => ({
  kickNewdbPendingPoller: vi.fn(),
  startNewdbPendingPoller: vi.fn(),
  stopNewdbPendingPoller: vi.fn(),
}));

import { query, queryOne, execute } from '../config/postgres.js';
import { newdbBaseService } from './newdb-base.service.js';
import { kickNewdbPendingPoller } from './newdb-pending-poller.service.js';
import {
  normalizePassport,
  splitDocSeriaNumber,
  splitFullName,
  interpretNewdbResponse,
  runChecksForPass,
  refreshPendingForPass,
  pollAllPending,
  combinePatentStatus,
  listPassesForDepartment,
  splitPatentDoc,
  type CheckStatus,
} from './newdb-check.service.js';

const mockPost = newdbBaseService.post as Mock;
const mockQuery = query as Mock;
const mockQueryOne = queryOne as Mock;
const mockExecute = execute as Mock;

beforeEach(() => {
  vi.clearAllMocks();
  mockExecute.mockResolvedValue(undefined);
});

// ─── normalizePassport / splitDocSeriaNumber (реальные прод-кейсы) ───────────

describe('normalizePassport', () => {
  it('вырезает хвост « от DD.MM.YYYY» и возвращает дату отдельно', () => {
    expect(normalizePassport('404363576 от 10.11.2022')).toEqual({ doc: '404363576', issueDate: '10.11.2022' });
  });
  it('убирает хвостовую пунктуацию', () => {
    expect(normalizePassport('FB1695900,').doc).toBe('FB1695900');
  });
  it('транслитерирует кириллические двойники латиницы', () => {
    expect(normalizePassport('FК0244031').doc).toBe('FK0244031'); // К — кириллица
    expect(normalizePassport('FВ2075418').doc).toBe('FB2075418'); // В — кириллица
    expect(normalizePassport('РР 406553888').doc).toBe('PP 406553888'); // РР — кириллица
  });
  it('пустое/чистое значение проходит без изменений', () => {
    expect(normalizePassport(null)).toEqual({ doc: '', issueDate: null });
    expect(normalizePassport('FA2049504')).toEqual({ doc: 'FA2049504', issueDate: null });
  });
});

describe('splitDocSeriaNumber', () => {
  it('РФ-паспорт: 10 цифр (в т.ч. с двойными пробелами) → серия 4 + номер 6', () => {
    expect(splitDocSeriaNumber('70  02 525222')).toEqual({ seria: '7002', number: '525222' });
  });
  it('иностранный с буквенной серией', () => {
    expect(splitDocSeriaNumber('FA 1904758')).toEqual({ seria: 'FA', number: '1904758' });
    expect(splitDocSeriaNumber('FК0244031')).toEqual({ seria: 'FK', number: '0244031' });
    expect(splitDocSeriaNumber('РР 406553888')).toEqual({ seria: 'PP', number: '406553888' });
  });
  it('таджикский без серии: только номер, серия пустая', () => {
    expect(splitDocSeriaNumber('405995877')).toEqual({ seria: '', number: '405995877' });
  });
  it('«номер от даты» больше не даёт серию-мусор', () => {
    expect(splitDocSeriaNumber('404363576 от 10.11.2022')).toEqual({ seria: '', number: '404363576' });
  });
  it('хвостовая запятая не попадает в номер', () => {
    expect(splitDocSeriaNumber('FB1695900,')).toEqual({ seria: 'FB', number: '1695900' });
  });
});

describe('splitFullName', () => {
  it('фамилия/имя/остаток-отчество', () => {
    expect(splitFullName('Аминов Вахиджан Муратбой угли')).toEqual({
      lastName: 'Аминов', firstName: 'Вахиджан', secondName: 'Муратбой угли',
    });
  });
});

// ─── interpretNewdbResponse ──────────────────────────────────────────────────

describe('interpretNewdbResponse', () => {
  it('errors_info → финальная ошибка с текстом', () => {
    const r = interpretNewdbResponse('rkl', {
      requestId: 'req-1',
      errors_info: [{ error: 'id_doc_seria must be non-empty', error_code: 400 }],
    });
    expect(r.status).toBe('error');
    expect(r.providerStatus).toBe('errors_info');
    expect(r.errorMessage).toContain('id_doc_seria must be non-empty');
  });

  it('errors_info: пустой массив или не-массив НЕ даёт ошибку', () => {
    expect(interpretNewdbResponse('rkl', { errors_info: [] }).status).toBe('pending');
    expect(interpretNewdbResponse('rkl', { errors_info: 'oops' }).status).toBe('pending');
  });

  it('state=restart с ошибкой результата → pending с причиной в summary', () => {
    const r = interpretNewdbResponse('rkl', {
      state: 'restart',
      requestId: 'req-2',
      results: { rkl: { result: { error: 'spider system error', status: 500 } } },
    });
    expect(r.status).toBe('pending');
    expect(r.summary).toContain('spider system error');
    expect(r.requestId).toBe('req-2');
  });

  it('state=error → финальная ошибка', () => {
    const r = interpretNewdbResponse('rkl', { state: 'error' });
    expect(r.status).toBe('error');
    expect(r.errorMessage).toBeTruthy();
  });

  it('ошибка результата вне restart → финальная ошибка', () => {
    const r = interpretNewdbResponse('patent_msk', {
      state: 'queued',
      results: { patent_msk: { result: { error: 'internal failure' } } },
    });
    expect(r.status).toBe('error');
    expect(r.errorMessage).toContain('internal failure');
  });

  it('complete без данных → финальная ошибка, не pending', () => {
    const r = interpretNewdbResponse('rkl', { state: 'complete', results: { rkl: { result: { data: [] } } } });
    expect(r.status).toBe('error');
  });

  it('queued без результата → pending с requestId', () => {
    const r = interpretNewdbResponse('rkl', { state: 'queued', requestId: 'req-3' });
    expect(r.status).toBe('pending');
    expect(r.requestId).toBe('req-3');
  });

  it('complete rkl: not_found → clean, found → found, неизвестный → error', () => {
    const mk = (registry_status: string) => ({
      state: 'complete',
      results: { rkl: { result: { data: [{ registry_status, title: 't' }] } } },
    });
    expect(interpretNewdbResponse('rkl', mk('not_found')).status).toBe('clean');
    expect(interpretNewdbResponse('rkl', mk('found')).status).toBe('found');
    expect(interpretNewdbResponse('rkl', mk('weird')).status).toBe('error');
  });

  it('complete patent: valid → clean, expired/not_found → invalid, неизвестный → error', () => {
    const mk = (status: string) => ({
      state: 'complete',
      results: { patent_msk: { result: { data: [{ status, message: 'm' }] } } },
    });
    expect(interpretNewdbResponse('patent_msk', mk('valid')).status).toBe('clean');
    expect(interpretNewdbResponse('patent_msk', mk('expired')).status).toBe('invalid');
    expect(interpretNewdbResponse('patent_msk', mk('not_found')).status).toBe('invalid');
    expect(interpretNewdbResponse('patent_msk', mk('weird')).status).toBe('error');
  });
});

// ─── Поведенческие: runChecksForPass ─────────────────────────────────────────

const CHECK_ID = '11111111-1111-1111-1111-111111111111';

const basePass = {
  id: '22222222-2222-2222-2222-222222222222',
  org_department_id: '33333333-3333-3333-3333-333333333333',
  holder_name: 'Сотимджони Нумон Зиезода',
  birth_date: '1992-11-07',
  passport_series_number: '405995877',
  passport_issue_date: '2025-04-09',
  citizenship: 'Таджикистан',
  patent_number: null,
  patent_blank_number: null,
  has_residence_permit: false,
  residence_permit_number: null,
};

/** Настроить queryOne под жизненный цикл runChecksForPass. */
const mockPassFlow = (pass: Record<string, unknown>) => {
  mockQueryOne.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM contractor_passes')) return pass;
    if (sql.includes("status = 'pending'")) return null;      // hasBlockingCheck: pending
    if (sql.includes('request_sent = true')) return null;     // hasBlockingCheck: окно
    if (sql.includes('INSERT INTO newdb_checks')) return { id: CHECK_ID, created_at: '2026-07-14T10:00:00Z' };
    if (sql.includes('UPDATE newdb_checks')) return { request_sent: true };
    return null;
  });
};

const completeRkl = {
  state: 'complete',
  requestId: 'req-ok',
  results: { rkl: { result: { data: [{ registry_status: 'not_found', title: 'ok' }] } } },
};

const completePatent = {
  state: 'complete',
  requestId: 'req-ok',
  results: { patent_msk: { result: { data: [{ status: 'valid', message: 'ok' }] } } },
};

/**
 * Пропуск с полным набором данных для федерального патента.
 * Форматы — как в проде: патент «77 №2400123456», бланк «ФМ1234567».
 */
const federalPass = {
  ...basePass,
  passport_series_number: 'FA7726115',
  citizenship: 'Узбекистан',
  patent_number: '77 №2400123456',
  patent_blank_number: 'ФМ1234567',
};

const completeFederal = (docStatus: string) => ({
  state: 'complete',
  requestId: 'req-fed',
  results: { foreign_patent: { result: { data: [{ doc_status: docStatus }] } } },
});

describe('runChecksForPass — что уходит (и не уходит) провайдеру', () => {
  it('РКЛ для гражданства «Россия»: внешний вызов НЕ выполняется, статус not_applicable', async () => {
    mockPassFlow({ ...basePass, citizenship: 'Россия' });
    const results = await runChecksForPass(basePass.id, ['rkl'], 'user-1');
    expect(mockPost).not.toHaveBeenCalled();
    expect(results[0].status).toBe('not_applicable');
  });

  it('патент: известное непатентное гражданство → not_applicable без вызова', async () => {
    mockPassFlow({ ...basePass, citizenship: 'Кыргызстан' });
    const results = await runChecksForPass(basePass.id, ['patent_msk'], 'user-1');
    expect(mockPost).not.toHaveBeenCalled();
    expect(results[0].status).toBe('not_applicable');
  });

  it('патент: ВНЖ → not_applicable без вызова', async () => {
    mockPassFlow({ ...basePass, has_residence_permit: true });
    const results = await runChecksForPass(basePass.id, ['patent_msk'], 'user-1');
    expect(mockPost).not.toHaveBeenCalled();
    expect(results[0].status).toBe('not_applicable');
  });

  it('паспорт без серии: в body РКЛ нет ключа id_doc_seria (не пустая строка)', async () => {
    mockPassFlow(basePass);
    mockPost.mockResolvedValue(completeRkl);
    await runChecksForPass(basePass.id, ['rkl'], 'user-1');
    expect(mockPost).toHaveBeenCalledTimes(1);
    const body = mockPost.mock.calls[0][0];
    expect(body.params).not.toHaveProperty('id_doc_seria');
    expect(body.params.id_doc_number).toBe('405995877');
    expect(body.params.issue_date).toBe('09.04.2025');
  });

  it('пустое гражданство: патент проверяется, в body нет ключа citizenship', async () => {
    mockPassFlow({ ...basePass, citizenship: null, passport_series_number: 'FA1904758' });
    mockPost.mockResolvedValue(completePatent);
    const results = await runChecksForPass(basePass.id, ['patent_msk'], 'user-1');
    expect(mockPost).toHaveBeenCalledTimes(1);
    const body = mockPost.mock.calls[0][0];
    expect(body.params).not.toHaveProperty('citizenship');
    expect(body.params.id_doc_seria).toBe('FA');
    expect(body.params.id_doc_number).toBe('1904758');
    expect(results[0].status).toBe('clean');
  });

  it('гражданство «Другое»: патент проверяется без citizenship', async () => {
    mockPassFlow({ ...basePass, citizenship: 'Другое', passport_series_number: 'FA1904758' });
    mockPost.mockResolvedValue(completePatent);
    await runChecksForPass(basePass.id, ['patent_msk'], 'user-1');
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockPost.mock.calls[0][0].params).not.toHaveProperty('citizenship');
  });

  it('патентное гражданство: citizenship передаётся', async () => {
    mockPassFlow({ ...basePass, passport_series_number: 'FA1904758' }); // Таджикистан
    mockPost.mockResolvedValue(completePatent);
    await runChecksForPass(basePass.id, ['patent_msk'], 'user-1');
    expect(mockPost.mock.calls[0][0].params.citizenship).toBe('Таджикистан');
  });

  it('патент без серии паспорта: внешний вызов НЕ выполняется, ошибка «серия паспорта»', async () => {
    mockPassFlow(basePass); // паспорт 405995877 — без серии
    const results = await runChecksForPass(basePass.id, ['patent_msk'], 'user-1');
    expect(mockPost).not.toHaveBeenCalled();
    expect(results[0].status).toBe('error');
    expect(results[0].error_message).toContain('серия паспорта');
  });

  it('kick поллера: вызывается при pending-результате, не вызывается без него', async () => {
    mockPassFlow(basePass);
    mockPost.mockResolvedValue({ state: 'queued', requestId: 'req-q' });
    await runChecksForPass(basePass.id, ['rkl'], 'user-1');
    expect(kickNewdbPendingPoller).toHaveBeenCalledTimes(1);

    vi.mocked(kickNewdbPendingPoller).mockClear();
    mockPost.mockResolvedValue(completeRkl);
    await runChecksForPass(basePass.id, ['rkl'], 'user-1');
    expect(kickNewdbPendingPoller).not.toHaveBeenCalled();
  });

  it('issue_date-фолбэк из строки паспорта «… от DD.MM.YYYY»', async () => {
    mockPassFlow({ ...basePass, passport_series_number: '404363576 от 10.11.2022', passport_issue_date: null });
    mockPost.mockResolvedValue(completeRkl);
    await runChecksForPass(basePass.id, ['rkl'], 'user-1');
    const body = mockPost.mock.calls[0][0];
    expect(body.params.issue_date).toBe('10.11.2022');
    expect(body.params.id_doc_number).toBe('404363576');
    expect(body.params).not.toHaveProperty('id_doc_seria');
  });

  it('просроченный pending закрывается как timeout перед новым запуском', async () => {
    mockPassFlow(basePass);
    mockPost.mockResolvedValue(completeRkl);
    await runChecksForPass(basePass.id, ['rkl'], 'user-1');
    const timeoutUpdate = mockExecute.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('истёк срок ожидания'),
    );
    expect(timeoutUpdate).toBeTruthy();
    expect(timeoutUpdate![0]).toContain("status = 'pending'");
    expect(timeoutUpdate![0]).toContain('24 hours');
  });

  it('ответ errors_info при запуске → запись со status=error и причиной', async () => {
    mockPassFlow(basePass);
    mockPost.mockResolvedValue({
      requestId: 'req-err',
      errors_info: [{ error: 'id_doc_seria must be non-empty', error_code: 400 }],
    });
    const results = await runChecksForPass(basePass.id, ['rkl'], 'user-1');
    expect(results[0].status).toBe('error');
    expect(results[0].error_message).toContain('id_doc_seria must be non-empty');
  });
});

// ─── Поведенческие: refreshPendingForPass (polling) ──────────────────────────

describe('refreshPendingForPass — polling', () => {
  it('сохранённый raw_response с errors_info: завершается локально, провайдер НЕ вызывается', async () => {
    mockQuery.mockResolvedValue([{
      id: CHECK_ID,
      check_type: 'rkl',
      newdb_request_id: 'req-old',
      saved_raw: {
        params: { method: 'rkl', id_doc_seria: '', id_doc_number: '405995877' },
        requestId: 'req-old',
        errors_info: [{ error: 'id_doc_seria must be non-empty', error_code: 400 }],
      },
    }]);

    const summary = await refreshPendingForPass(basePass.id);

    expect(mockPost).not.toHaveBeenCalled();
    expect(summary.updated).toBe(1);
    const [sql, params] = mockExecute.mock.calls[0];
    expect(sql).toContain('UPDATE newdb_checks');
    expect(params[1]).toBe('error');                                   // status
    expect(params[2]).toBe('errors_info');                             // provider_status
    expect(params[4]).toContain('id_doc_seria must be non-empty');     // error_message
  });

  it('stillPending (restart): статус не меняется, но result_summary с причиной сохраняется', async () => {
    mockQuery.mockResolvedValue([{
      id: CHECK_ID,
      check_type: 'rkl',
      newdb_request_id: 'req-r',
      saved_raw: { state: 'queued', params: { method: 'rkl' }, requestId: 'req-r' },
    }]);
    mockPost.mockResolvedValue({
      state: 'restart',
      requestId: 'req-r',
      results: { rkl: { result: { error: 'spider system error', status: 500 } } },
    });

    const summary = await refreshPendingForPass(basePass.id);

    expect(summary.stillPending).toBe(1);
    const [sql, params] = mockExecute.mock.calls[0];
    expect(sql).toContain('result_summary');
    expect(params).toEqual(expect.arrayContaining([
      expect.stringContaining('spider system error'),
    ]));
  });

  it('финальный error при polling сохраняет error_message (не затирает NULL)', async () => {
    mockQuery.mockResolvedValue([{
      id: CHECK_ID,
      check_type: 'rkl',
      newdb_request_id: 'req-f',
      saved_raw: { state: 'queued', params: { method: 'rkl' }, requestId: 'req-f' },
    }]);
    mockPost.mockResolvedValue({
      state: 'error',
      requestId: 'req-f',
      results: { rkl: { result: { error: 'permanent failure' } } },
    });

    const summary = await refreshPendingForPass(basePass.id);

    expect(summary.updated).toBe(1);
    const [, params] = mockExecute.mock.calls[0];
    expect(params[1]).toBe('error');                       // status
    expect(params[6]).toContain('permanent failure');      // error_message
  });

  it('pending без requestId: закрывается ошибкой «нет requestId», провайдер не вызывается', async () => {
    mockQuery.mockResolvedValue([{
      id: CHECK_ID,
      check_type: 'rkl',
      newdb_request_id: null,
      saved_raw: { state: 'queued', params: { method: 'rkl' } },
    }]);

    const summary = await refreshPendingForPass(basePass.id);
    expect(summary.skipped).toBe(1);
    expect(mockPost).not.toHaveBeenCalled();
    const closeCall = mockExecute.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('невозможно обновить: нет requestId'),
    );
    expect(closeCall).toBeTruthy();
  });
});

// ─── Поведенческие: pollAllPending (фоновый поллер) ──────────────────────────

describe('pollAllPending', () => {
  it('сначала глобально закрывает просроченные pending, затем обходит выборку', async () => {
    mockQuery.mockResolvedValue([{
      id: CHECK_ID,
      check_type: 'rkl',
      newdb_request_id: 'req-1',
      saved_raw: { state: 'queued', params: { method: 'rkl' }, requestId: 'req-1' },
    }]);
    mockPost.mockResolvedValue({
      state: 'complete',
      requestId: 'req-1',
      results: { rkl: { result: { data: [{ registry_status: 'not_found', title: 'ok' }] } } },
    });

    const summary = await pollAllPending(15);

    // 1-й execute — глобальный timeout-UPDATE (без фильтра по пропуску).
    const [timeoutSql, timeoutParams] = mockExecute.mock.calls[0];
    expect(timeoutSql).toContain('истёк срок ожидания');
    expect(timeoutSql).not.toContain('contractor_pass_id');
    expect(timeoutSql).toContain('24 hours');
    expect(timeoutParams).toBeUndefined();

    // Выборка глобальная, с лимитом.
    const [selectSql, selectParams] = mockQuery.mock.calls[0];
    expect(selectSql).not.toContain('contractor_pass_id');
    expect(selectParams).toEqual([15]);

    expect(summary.updated).toBe(1);
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it('пустая выборка: только timeout-UPDATE, провайдер не вызывается', async () => {
    mockQuery.mockResolvedValue([]);
    const summary = await pollAllPending();
    expect(summary).toEqual({ updated: 0, stillPending: 0, errors: 0, skipped: 0 });
    expect(mockPost).not.toHaveBeenCalled();
  });
});

// ─── Федеральный патент (foreign_patent) ────────────────────────────────────

describe('splitPatentDoc — форматы патента/бланка из прода', () => {
  it('патент «77 №2400123456»: серия = код региона, № в серию не попадает', () => {
    expect(splitPatentDoc('77 №2400123456')).toEqual({ seria: '77', number: '2400123456' });
  });
  it('бланк «ФМ1234567»: кириллическая серия сохраняется (не латинизируется)', () => {
    expect(splitPatentDoc('ФМ1234567')).toEqual({ seria: 'ФМ', number: '1234567' });
  });
  it('бланк «АА 9999999» с пробелом', () => {
    expect(splitPatentDoc('АА 9999999')).toEqual({ seria: 'АА', number: '9999999' });
  });
  it('бланк из одних цифр: серии нет', () => {
    expect(splitPatentDoc('7654321')).toEqual({ seria: '', number: '7654321' });
  });
  it('пусто/null → пустые поля', () => {
    expect(splitPatentDoc(null)).toEqual({ seria: '', number: '' });
    expect(splitPatentDoc('  ')).toEqual({ seria: '', number: '' });
  });
});

describe('interpretNewdbResponse — foreign_patent (doc_status)', () => {
  const interp = (docStatus: string) => interpretNewdbResponse('patent', completeFederal(docStatus));

  it('«Действителен» → clean', () => {
    expect(interp('Действителен').status).toBe('clean');
  });
  it('«Оформлен» → clean', () => {
    expect(interp('Оформлен').status).toBe('clean');
  });

  // Регрессия: в первой реализации позитивная проверка includes('действ') стояла
  // ПЕРВОЙ, поэтому «не действителен» ложно становился clean.
  it('«Не действителен» → invalid (негатив проверяется раньше позитива)', () => {
    expect(interp('Не действителен').status).toBe('invalid');
  });
  it('«Недействителен» → invalid', () => {
    expect(interp('Недействителен').status).toBe('invalid');
  });
  it('«Аннулирован» → invalid', () => {
    expect(interp('Аннулирован').status).toBe('invalid');
  });
  it('«Не найден» → invalid', () => {
    expect(interp('Не найден').status).toBe('invalid');
  });

  it('неизвестная формулировка → error, сырьё в summary (не «чисто» и не ❌)', () => {
    const r = interp('Ожидает решения');
    expect(r.status).toBe('error');
    expect(r.summary).toBe('Ожидает решения');
    expect(r.providerStatus).toBe('Ожидает решения');
  });
  it('пустой doc_status → error', () => {
    expect(interp('').status).toBe('error');
  });

  it('queued → pending (async как у остальных методов)', () => {
    const r = interpretNewdbResponse('patent', { state: 'queued', requestId: 'req-fed' });
    expect(r.status).toBe('pending');
    expect(r.requestId).toBe('req-fed');
  });

  // Ключевое: наш check_type 'patent' ↔ метод провайдера foreign_patent.
  it('результат читается из results.foreign_patent, а не results.patent', () => {
    const wrongKey = { state: 'complete', results: { patent: { result: { data: [{ doc_status: 'Действителен' }] } } } };
    expect(interpretNewdbResponse('patent', wrongKey).status).toBe('error');
    expect(interpretNewdbResponse('patent', completeFederal('Действителен')).status).toBe('clean');
  });
});

describe('runChecksForPass — федеральный патент', () => {
  it('в body уходят паспорт + номер патента + бланк + dob (YYYY-MM-DD)', async () => {
    mockPassFlow(federalPass);
    mockPost.mockResolvedValue(completeFederal('Действителен'));
    const results = await runChecksForPass(federalPass.id, ['patent'], 'user-1');

    const body = mockPost.mock.calls[0][0];
    expect(body.params.method).toBe('foreign_patent');
    expect(body.params.doctype).toBe('patent');
    expect(body.params.id_doc_seria).toBe('FA');
    expect(body.params.id_doc_number).toBe('7726115');
    expect(body.params.doc_seria).toBe('77');          // код региона до «№»
    expect(body.params.doc_number).toBe('2400123456');
    expect(body.params.blank_seria).toBe('ФМ');        // кириллица НЕ латинизируется
    expect(body.params.blank_number).toBe('1234567');
    expect(body.params.dob).toBe('1992-11-07');
    expect(results[0].status).toBe('clean');
  });

  it('нет номера патента: платного вызова и markSent нет', async () => {
    mockPassFlow({ ...federalPass, patent_number: null });
    const results = await runChecksForPass(federalPass.id, ['patent'], 'user-1');
    expect(mockPost).not.toHaveBeenCalled();
    expect(results[0].status).toBe('error');
    expect(results[0].error_message).toContain('номер патента');
    // request_sent в результате читается из UPDATE...RETURNING (в моке всегда true),
    // поэтому проверяем факт: markSent не выставлял флаг.
    const markSentCall = mockExecute.mock.calls.find(([sql]) => String(sql).includes('SET request_sent = true'));
    expect(markSentCall).toBeUndefined();
  });

  it('нет бланка патента: отдельная ошибка, платного вызова нет', async () => {
    mockPassFlow({ ...federalPass, patent_blank_number: null });
    const results = await runChecksForPass(federalPass.id, ['patent'], 'user-1');
    expect(mockPost).not.toHaveBeenCalled();
    expect(results[0].status).toBe('error');
    expect(results[0].error_message).toContain('бланк патента');
    expect(results[0].error_message).not.toContain('номер патента');
  });

  // Кейс Нормуминова (2065): бланк хранится как 7 цифр без букв — серии нет.
  // Провайдер отвечал «Отсутствует обязательный параметр: blank_seria»;
  // теперь ловим локально, до списания и с понятным текстом.
  it('бланк без серии (одни цифры): платного вызова и markSent нет', async () => {
    mockPassFlow({ ...federalPass, patent_blank_number: '7654321' });
    const results = await runChecksForPass(federalPass.id, ['patent'], 'user-1');
    expect(mockPost).not.toHaveBeenCalled();
    expect(results[0].status).toBe('error');
    expect(results[0].error_message).toContain('серия бланка патента');
    const markSentCall = mockExecute.mock.calls.find(([sql]) => String(sql).includes('SET request_sent = true'));
    expect(markSentCall).toBeUndefined();
  });

  it('паспорт без буквенной серии: платного вызова и markSent нет', async () => {
    mockPassFlow({ ...federalPass, passport_series_number: '405512294' });
    const results = await runChecksForPass(federalPass.id, ['patent'], 'user-1');
    expect(mockPost).not.toHaveBeenCalled();
    expect(results[0].status).toBe('error');
    expect(results[0].error_message).toContain('серия паспорта');
    const markSentCall = mockExecute.mock.calls.find(([sql]) => String(sql).includes('SET request_sent = true'));
    expect(markSentCall).toBeUndefined();
  });

  it('гражданство РФ → not_applicable, вызова нет', async () => {
    mockPassFlow({ ...federalPass, citizenship: 'Россия' });
    const results = await runChecksForPass(federalPass.id, ['patent'], 'user-1');
    expect(mockPost).not.toHaveBeenCalled();
    expect(results[0].status).toBe('not_applicable');
  });

  it('аудит: INSERT сохраняет и patent_number, и patent_blank_number', async () => {
    mockPassFlow(federalPass);
    mockPost.mockResolvedValue(completeFederal('Действителен'));
    await runChecksForPass(federalPass.id, ['patent'], 'user-1');

    const insert = mockQueryOne.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO newdb_checks'));
    expect(insert).toBeTruthy();
    expect(String(insert![0])).toContain('patent_blank_number');
    expect(insert![1]).toContain('77 №2400123456'); // patent_number
    expect(insert![1]).toContain('ФМ1234567');      // patent_blank_number
  });

  it('dispatch: тип patent идёт в foreign_patent, а не в patent_msk', async () => {
    mockPassFlow(federalPass);
    mockPost.mockResolvedValue(completeFederal('Действителен'));
    await runChecksForPass(federalPass.id, ['patent'], 'user-1');
    expect(mockPost.mock.calls[0][0].params.method).toBe('foreign_patent');
  });
});

describe('async-цикл для patent: queued → polling → complete', () => {
  it('поллер по check_type=patent опрашивает и завершает через results.foreign_patent', async () => {
    // Первый ответ — queued: запись остаётся pending с сохранённым requestId.
    mockPassFlow(federalPass);
    mockPost.mockResolvedValue({ state: 'queued', requestId: 'req-fed', params: { method: 'foreign_patent' } });
    const first = await runChecksForPass(federalPass.id, ['patent'], 'user-1');
    expect(first[0].status).toBe('pending');
    expect(kickNewdbPendingPoller).toHaveBeenCalled();

    // Поллер добирает результат: важно, что check_type='patent' резолвится в
    // foreign_patent — иначе complete-ответ не распарсился бы.
    mockQuery.mockResolvedValue([{
      id: CHECK_ID,
      check_type: 'patent',
      newdb_request_id: 'req-fed',
      saved_raw: { state: 'queued', params: { method: 'foreign_patent' }, requestId: 'req-fed' },
    }]);
    mockPost.mockResolvedValue(completeFederal('Действителен'));

    const summary = await pollAllPending();
    expect(summary.updated).toBe(1);
    const finalUpdate = mockExecute.mock.calls.find(([sql]) => String(sql).includes('raw_response'));
    expect(finalUpdate![1]).toContain('clean');
  });

  it('SQL-выборки поллера включают тип patent', async () => {
    mockQuery.mockResolvedValue([]);
    await pollAllPending();
    const selects = mockQuery.mock.calls.map(([sql]) => String(sql));
    expect(selects.some(s => s.includes("'patent'"))).toBe(true);
    const timeouts = mockExecute.mock.calls.map(([sql]) => String(sql));
    expect(timeouts.some(s => s.includes("'patent'"))).toBe(true);
  });
});

// ─── Сводный статус патента ─────────────────────────────────────────────────

describe('combinePatentStatus', () => {
  const cases: Array<[CheckStatus | null, CheckStatus | null, CheckStatus | null, string]> = [
    ['invalid', 'clean', 'clean', 'кейс Нормуминова: Москва истекла, РФ жив'],
    ['clean', 'invalid', 'clean', 'clean выигрывает с любой стороны'],
    ['invalid', 'error', 'error', 'РФ неизвестен → НЕ красим красным'],
    ['invalid', 'found', 'error', 'found = неизвестная формулировка (старые строки)'],
    ['invalid', null, null, 'РФ не проверялся → проверено не полностью'],
    ['invalid', 'not_applicable', 'invalid', 'все применимые завершены и отрицательны'],
    ['invalid', 'invalid', 'invalid', 'оба отрицательны'],
    ['pending', 'invalid', 'pending', 'ещё может стать clean'],
    ['clean', 'pending', 'clean', 'clean важнее pending'],
    ['not_applicable', null, null, 'не проверялось'],
    ['not_applicable', 'not_applicable', 'not_applicable', 'патент не требуется'],
    [null, null, null, 'не проверялось вовсе'],
  ];

  it.each(cases)('msk=%s + rf=%s → %s (%s)', (msk, rf, expected) => {
    expect(combinePatentStatus(msk, rf)).toBe(expected);
  });

  it('никогда не даёт invalid, если есть неопределённость', () => {
    for (const unknown of ['error', 'found', null] as (CheckStatus | null)[]) {
      expect(combinePatentStatus('invalid', unknown)).not.toBe('invalid');
    }
  });
});

describe('listPassesForDepartment — сводный статус подключён', () => {
  it('строка отдаёт overall + at/summary от источника, определившего итог', async () => {
    mockQuery.mockResolvedValue([{
      id: 'p1',
      pass_number: '2065',
      holder_name: 'Нормуминов Ойбек Бахтиярович',
      citizenship: 'Узбекистан',
      passport_series_number: 'FA7726115',
      patent_number: '77 2400123456',
      has_residence_permit: false,
      last_rkl_status: 'clean',
      last_rkl_at: '2026-07-15T08:00:00Z',
      last_rkl_summary: 'ok',
      last_patent_msk_status: 'invalid',
      last_patent_msk_at: '2026-07-15T08:10:00Z',
      last_patent_msk_summary: 'истёк 28.03.2026',
      last_patent_rf_status: 'clean',
      last_patent_rf_at: '2026-07-15T08:20:00Z',
      last_patent_rf_summary: 'Действителен',
    }]);

    const [row] = await listPassesForDepartment('dep-1');
    expect(row.last_patent_overall_status).toBe('clean');
    // at/summary — от РФ (он определил итог), а не от Москвы.
    expect(row.last_patent_overall_at).toBe('2026-07-15T08:20:00Z');
    expect(row.last_patent_overall_summary).toBe('Действителен');
  });

  it('запрос содержит LATERAL по check_type=patent', async () => {
    mockQuery.mockResolvedValue([]);
    await listPassesForDepartment('dep-1');
    expect(String(mockQuery.mock.calls[0][0])).toContain("c.check_type = 'patent'");
  });
});
