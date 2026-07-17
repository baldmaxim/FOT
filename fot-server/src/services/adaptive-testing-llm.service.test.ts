import { beforeEach, describe, expect, it, vi } from 'vitest';

const { pgExecute, chatMock, resolvedConfigMock } = vi.hoisted(() => ({
  pgExecute: vi.fn(),
  chatMock: vi.fn(),
  resolvedConfigMock: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: pgExecute,
  withTransaction: vi.fn(),
}));

vi.mock('./settings.service.js', () => ({
  settingsService: { getResolvedAdaptiveLlmConfig: resolvedConfigMock },
}));

vi.mock('./openrouter.service.js', () => {
  class OpenRouterError extends Error {
    status: number | null;
    constructor(message: string, status: number | null) {
      super(message);
      this.name = 'OpenRouterError';
      this.status = status;
    }
  }
  return { OpenRouterError, openRouterService: { chatCompletion: chatMock } };
});

import {
  adaptiveTestingLlmService,
  redactPii,
  validateGeneratedQuestion,
} from './adaptive-testing-llm.service.js';
import type { IAdaptiveProfileSnapshot } from '../types/adaptive-testing.types.js';

const OK_CONFIG = {
  ok: true as const,
  apiKey: 'k',
  baseUrl: 'https://proxyllm.fvds.ru/api/v1',
  model: 'openai/gpt-5.6-luna',
  zdrRequired: false,
  connectionMode: 'shared_proxy' as const,
};

const SNAPSHOT: IAdaptiveProfileSnapshot = {
  profileId: 'p1',
  title: 'Профиль',
  departmentName: 'Отдел закупок',
  positionName: 'Специалист',
  dutiesText: 'Оформление заявок, работа с поставщиками.',
  competencies: [{ key: 'docs', name: 'Документы' }],
};

const llmResponse = (content: string, model = 'openai/gpt-5.6-luna', finishReason = 'stop') => ({
  id: '1',
  model,
  resolvedModel: model,
  choices: [{ index: 0, message: { role: 'assistant' as const, content }, finish_reason: finishReason }],
  usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, cost: 0.001 },
});

beforeEach(() => {
  vi.clearAllMocks();
  resolvedConfigMock.mockResolvedValue(OK_CONFIG);
  pgExecute.mockResolvedValue(1);
});

describe('validateGeneratedQuestion (cross-field)', () => {
  const base = {
    question_text: 'Какой порядок оформления заявки на закупку?',
    options: [
      { id: 'a', text: 'Вариант 1' },
      { id: 'b', text: 'Вариант 2' },
      { id: 'c', text: 'Вариант 3' },
    ],
    correct_option_ids: ['a'],
    rubric: null,
  };

  it('single: валидный проходит', () => {
    const q = validateGeneratedQuestion(base, 'single');
    expect(q.correct_option_ids).toEqual(['a']);
  });

  it('дублирующиеся id вариантов отклоняются', () => {
    const bad = { ...base, options: [{ id: 'a', text: '1' }, { id: 'a', text: '2' }, { id: 'b', text: '3' }] };
    expect(() => validateGeneratedQuestion(bad, 'single')).toThrow(/дублирующиеся/);
  });

  it('correct_option_ids вне options отклоняются', () => {
    expect(() => validateGeneratedQuestion({ ...base, correct_option_ids: ['z'] }, 'single')).toThrow(/вне options/);
  });

  it('single: два правильных отклоняются', () => {
    expect(() => validateGeneratedQuestion({ ...base, correct_option_ids: ['a', 'b'] }, 'single')).toThrow(/ровно один/);
  });

  it('multiple: все варианты правильные — отклоняется', () => {
    expect(() => validateGeneratedQuestion({ ...base, correct_option_ids: ['a', 'b', 'c'] }, 'multiple')).toThrow(/не могут быть все/);
  });

  it('text: без рубрики отклоняется, с рубрикой — options обнуляются', () => {
    expect(() => validateGeneratedQuestion(base, 'text')).toThrow(/без рубрики/);
    const q = validateGeneratedQuestion(
      { ...base, rubric: ['Назван срок', 'Назван ответственный'] },
      'text',
    );
    expect(q.options).toBeNull();
    expect(q.correct_option_ids).toBeNull();
    expect(q.rubric).toHaveLength(2);
  });
});

describe('redactPii', () => {
  it('вырезает email, телефоны и длинные числовые идентификаторы', () => {
    const out = redactPii('Пишите на ivanov@mail.ru или +7 (999) 123-45-67, табельный 1234567890');
    expect(out).not.toContain('ivanov@mail.ru');
    expect(out).not.toContain('123-45-67');
    expect(out).not.toContain('1234567890');
    expect(out).toContain('[email]');
    expect(out).toContain('[телефон]');
  });
});

describe('generateQuestion', () => {
  it('передаёт в LLM только рабочий контекст (без ФИО/email/UUID)', async () => {
    chatMock.mockResolvedValue(llmResponse(JSON.stringify({
      question_text: 'Каков порядок оформления заявки на закупку материалов?',
      options: [{ id: 'a', text: '1' }, { id: 'b', text: '2' }, { id: 'c', text: '3' }],
      correct_option_ids: ['a'],
      rubric: null,
    })));

    await adaptiveTestingLlmService.generateQuestion({
      sessionId: 's1',
      snapshot: SNAPSHOT,
      competency: SNAPSHOT.competencies[0],
      difficulty: 1,
      type: 'single',
      seq: 1,
      askedQuestions: [],
      gapTags: [],
    });

    const [payload, opts] = chatMock.mock.calls[0];
    const userContent = JSON.stringify(payload.messages);
    expect(Object.keys(JSON.parse(payload.messages[1].content as string))).toEqual([
      'department', 'position', 'duties', 'competency', 'difficulty', 'question_type',
      'already_asked_questions', 'known_gaps',
    ]);
    expect(userContent).not.toContain('s1'); // UUID сессии не отправляется
    expect(payload.provider).toMatchObject({ data_collection: 'deny', require_parameters: true, allow_fallbacks: false });
    expect(payload.temperature).toBeUndefined(); // Luna не поддерживает temperature
    expect(opts).toMatchObject({ modelOverride: 'openai/gpt-5.6-luna', maxAttempts: 1 });
  });

  it('невалидный JSON — ошибка + запись invalid_json в ledger', async () => {
    chatMock.mockResolvedValue(llmResponse('это не JSON вовсе'));
    await expect(adaptiveTestingLlmService.generateQuestion({
      sessionId: 's1',
      snapshot: SNAPSHOT,
      competency: SNAPSHOT.competencies[0],
      difficulty: 1,
      type: 'single',
      seq: 1,
      askedQuestions: [],
      gapTags: [],
    })).rejects.toThrow(/невалидный JSON/);

    const statuses = pgExecute.mock.calls.map(c => (c[1] as unknown[])[6]);
    expect(statuses).toContain('ok'); // сам вызов оплачен и учтён
    expect(statuses).toContain('invalid_json');
  });

  it('finish_reason=length — ошибка попытки, usage всё равно учтён', async () => {
    chatMock.mockResolvedValue(llmResponse('{}', 'openai/gpt-5.6-luna', 'length'));
    await expect(adaptiveTestingLlmService.generateQuestion({
      sessionId: 's1',
      snapshot: SNAPSHOT,
      competency: SNAPSHOT.competencies[0],
      difficulty: 1,
      type: 'single',
      seq: 1,
      askedQuestions: [],
      gapTags: [],
    })).rejects.toThrow(/length/);
    expect(pgExecute).toHaveBeenCalled();
  });

  it('невалидная конфигурация (untrusted URL) — вызов LLM не выполняется', async () => {
    resolvedConfigMock.mockResolvedValue({ ok: false, reason: 'invalid_base_url' });
    await expect(adaptiveTestingLlmService.generateQuestion({
      sessionId: 's1',
      snapshot: SNAPSHOT,
      competency: SNAPSHOT.competencies[0],
      difficulty: 1,
      type: 'single',
      seq: 1,
      askedQuestions: [],
      gapTags: [],
    })).rejects.toThrow(/invalid_llm_config: invalid_base_url/);
    expect(chatMock).not.toHaveBeenCalled();
  });
});

describe('evaluateTextAnswer', () => {
  it('ответ сотрудника уходит с редукцией ПДн; оценка парсится', async () => {
    chatMock.mockResolvedValue(llmResponse(JSON.stringify({
      rubric_score: 3,
      matched: ['Назван срок'],
      missed: ['Не назван ответственный'],
      gap_tags: ['escalation_owner'],
    })));

    const result = await adaptiveTestingLlmService.evaluateTextAnswer({
      sessionId: 's1',
      snapshot: SNAPSHOT,
      competency: SNAPSHOT.competencies[0],
      questionText: 'Опишите порядок эскалации.',
      rubric: ['Назван срок', 'Назван ответственный'],
      answerText: 'Сообщаю на ivanov@mail.ru в течение часа',
    });

    expect(result.rubric_score).toBe(3);
    const sent = JSON.stringify(chatMock.mock.calls[0][0].messages);
    expect(sent).not.toContain('ivanov@mail.ru');
  });
});

describe('runHealthCheck', () => {
  it('успех: модель совпала, JSON валиден, usage есть', async () => {
    chatMock.mockResolvedValue(llmResponse(JSON.stringify({ ok: true })));
    const res = await adaptiveTestingLlmService.runHealthCheck({ zdr: false });
    expect(res.ok).toBe(true);
    expect(res.model).toContain('gpt-5.6-luna');
  });

  it('ответила другая модель (fallback прокси) — провал', async () => {
    chatMock.mockResolvedValue(llmResponse(JSON.stringify({ ok: true }), 'some/other-model'));
    const res = await adaptiveTestingLlmService.runHealthCheck({ zdr: false });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('другая модель');
  });

  it('не-JSON ответ — прокси не пересылает response_format', async () => {
    chatMock.mockResolvedValue(llmResponse('просто текст'));
    const res = await adaptiveTestingLlmService.runHealthCheck({ zdr: false });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('response_format');
  });

  it('zdr=true добавляет provider.zdr в запрос', async () => {
    chatMock.mockResolvedValue(llmResponse(JSON.stringify({ ok: true })));
    await adaptiveTestingLlmService.runHealthCheck({ zdr: true });
    expect(chatMock.mock.calls[0][0].provider).toMatchObject({ zdr: true, data_collection: 'deny' });
  });

  it('конфигурация не собирается — причина возвращается без вызова LLM', async () => {
    resolvedConfigMock.mockResolvedValue({ ok: false, reason: 'no_api_key' });
    const res = await adaptiveTestingLlmService.runHealthCheck({ zdr: false });
    expect(res.ok).toBe(false);
    expect(res.configReason).toBe('no_api_key');
    expect(chatMock).not.toHaveBeenCalled();
  });
});
