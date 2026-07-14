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

import { query, queryOne, execute } from '../config/postgres.js';
import { newdbBaseService } from './newdb-base.service.js';
import {
  normalizePassport,
  splitDocSeriaNumber,
  splitFullName,
  interpretNewdbResponse,
  runChecksForPass,
  refreshPendingForPass,
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
    mockPassFlow({ ...basePass, citizenship: null });
    mockPost.mockResolvedValue(completePatent);
    const results = await runChecksForPass(basePass.id, ['patent_msk'], 'user-1');
    expect(mockPost).toHaveBeenCalledTimes(1);
    const body = mockPost.mock.calls[0][0];
    expect(body.params).not.toHaveProperty('citizenship');
    expect(body.params).not.toHaveProperty('id_doc_seria');
    expect(results[0].status).toBe('clean');
  });

  it('гражданство «Другое»: патент проверяется без citizenship', async () => {
    mockPassFlow({ ...basePass, citizenship: 'Другое' });
    mockPost.mockResolvedValue(completePatent);
    await runChecksForPass(basePass.id, ['patent_msk'], 'user-1');
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockPost.mock.calls[0][0].params).not.toHaveProperty('citizenship');
  });

  it('патентное гражданство: citizenship передаётся', async () => {
    mockPassFlow(basePass); // Таджикистан
    mockPost.mockResolvedValue(completePatent);
    await runChecksForPass(basePass.id, ['patent_msk'], 'user-1');
    expect(mockPost.mock.calls[0][0].params.citizenship).toBe('Таджикистан');
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

  it('pending без requestId и без финального сохранённого ответа → skipped', async () => {
    mockQuery.mockResolvedValue([{
      id: CHECK_ID,
      check_type: 'rkl',
      newdb_request_id: null,
      saved_raw: { state: 'queued', params: { method: 'rkl' } },
    }]);

    const summary = await refreshPendingForPass(basePass.id);
    expect(summary.skipped).toBe(1);
    expect(mockPost).not.toHaveBeenCalled();
  });
});
