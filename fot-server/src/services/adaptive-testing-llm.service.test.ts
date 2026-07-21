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
  assertBalancedOptions,
  normalizeExtractedCompetencies,
  redactPii,
  validateGeneratedQuestion,
  MAX_EXTRACTED_COMPETENCIES,
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

describe('assertBalancedOptions — правильный вариант не выдаёт себя длиной', () => {
  const opt = (id: string, len: number) => ({ id, text: 'я'.repeat(len) });

  it('сбалансированные варианты проходят', () => {
    expect(() => assertBalancedOptions(
      [opt('a', 120), opt('b', 140), opt('c', 130), opt('d', 110)], ['b'],
    )).not.toThrow();
  });

  // Реальный Q1 первой сессии: 68 | 318* | 70 | 96 — «самый длинный» = правильный.
  it('правильный вариант в 3 раза длиннее — отклоняется', () => {
    expect(() => assertBalancedOptions(
      [opt('a', 68), opt('b', 318), opt('c', 70), opt('d', 96)], ['b'],
    )).toThrow(/разной длины|систематически длиннее/);
  });

  it('короткие варианты с небольшим разрывом — не ложное срабатывание', () => {
    // Реальный Q2 сессии: 66* | 54 | 87* | 43* | 50 — отношение шумит, подсказки нет.
    expect(() => assertBalancedOptions(
      [opt('a', 66), opt('b', 54), opt('c', 87), opt('d', 43), opt('e', 50)], ['a', 'c', 'd'],
    )).not.toThrow();
  });

  it('умеренный, но систематический перевес правильного — отклоняется', () => {
    // Реальный Q9: 120 | 217* | 125 | 140 — по общему разбросу (1.81) прошёл бы,
    // ловится сравнением средних: 217 против 128.
    expect(() => assertBalancedOptions(
      [opt('a', 120), opt('b', 217), opt('c', 125), opt('d', 140)], ['b'],
    )).toThrow(/систематически длиннее/);
  });

  it('длинный НЕверный вариант допустим — подсказки не создаёт', () => {
    expect(() => assertBalancedOptions(
      [opt('a', 150), opt('b', 120), opt('c', 130), opt('d', 140)], ['b'],
    )).not.toThrow();
  });

  it('multiple: правильные не длиннее неверных — проходит', () => {
    expect(() => assertBalancedOptions(
      [opt('a', 66), opt('b', 54), opt('c', 87), opt('d', 43), opt('e', 50)], ['a', 'd'],
    )).not.toThrow();
  });
});

describe('validateGeneratedQuestion — позиция правильного варианта', () => {
  it('порядок вариантов перемешивается, id и correct_option_ids сохраняются', () => {
    const options = Array.from({ length: 4 }, (_, i) => ({ id: 'abcd'[i], text: `Вариант ${'abcd'[i]} одинаковой длины` }));
    const positions = new Set<number>();

    // 40 прогонов: при живом перемешивании правильный id не залипает на одной позиции.
    for (let i = 0; i < 40; i += 1) {
      const q = validateGeneratedQuestion(
        { question_text: 'Достаточно длинный текст вопроса?', options, correct_option_ids: ['b'], rubric: null },
        'single',
      );
      expect(q.options?.map(o => o.id).sort()).toEqual(['a', 'b', 'c', 'd']);
      expect(q.correct_option_ids).toEqual(['b']);
      positions.add(q.options!.findIndex(o => o.id === 'b'));
    }
    expect(positions.size).toBeGreaterThan(1);
  });
});

describe('normalizeExtractedCompetencies', () => {
  const comp = (key: string, name = 'Тема') => ({ key, name, description: 'Описание темы' });

  it('валидные ключи сохраняются как есть', () => {
    const res = normalizeExtractedCompetencies({ competencies: [comp('architecture'), comp('code_quality')] });
    expect(res.map(c => c.key)).toEqual(['architecture', 'code_quality']);
  });

  // Ключ — идентификатор в competency_state сессии, кириллица и пробелы недопустимы.
  it('непригодный ключ заменяется на позиционный c{i}', () => {
    const res = normalizeExtractedCompetencies({
      competencies: [comp('Архитектура'), comp('work flow'), comp('ok_key')],
    });
    expect(res.map(c => c.key)).toEqual(['c1', 'c2', 'ok_key']);
  });

  it('дубликаты ключей разводятся, иначе две темы схлопнулись бы в одну', () => {
    const res = normalizeExtractedCompetencies({ competencies: [comp('llm'), comp('llm'), comp('llm')] });
    expect(res.map(c => c.key)).toEqual(['llm', 'llm_2', 'llm_3']);
  });

  it('лишние темы сверх лимита отбрасываются', () => {
    const many = Array.from({ length: 20 }, (_, i) => comp(`k${i}`));
    expect(normalizeExtractedCompetencies({ competencies: many })).toHaveLength(MAX_EXTRACTED_COMPETENCIES);
  });

  it('пустое описание не попадает в профиль', () => {
    const [c] = normalizeExtractedCompetencies({ competencies: [{ key: 'a1', name: 'Тема', description: '  ' }] });
    expect(c.description).toBeUndefined();
  });

  it('пустой список отклоняется — тестировать было бы нечего', () => {
    expect(() => normalizeExtractedCompetencies({ competencies: [] })).toThrow();
  });
});

describe('extractCompetencies', () => {
  it('разбирает ответ LLM и пишет вызов в ledger с назначением extract_competencies', async () => {
    chatMock.mockResolvedValueOnce(llmResponse(JSON.stringify({
      competencies: [
        { key: 'architecture', name: 'Архитектура решений', description: 'Выбор подхода' },
        { key: 'llm', name: 'Работа с LLM', description: 'Постановка задачи' },
      ],
    })));

    const res = await adaptiveTestingLlmService.extractCompetencies({
      skillMd: '# Методичка\n\nАрхитектура и LLM.',
      departmentName: 'ОЦТ',
      positionName: 'Разработчик',
    });

    expect(res).toHaveLength(2);
    expect(res[0]).toMatchObject({ key: 'architecture', name: 'Архитектура решений' });
    expect(pgExecute).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(['extract_competencies']));
  });

  it('cached_tokens из usage пишется в ledger', async () => {
    chatMock.mockResolvedValueOnce({
      ...llmResponse(JSON.stringify({ competencies: [{ key: 'a1', name: 'Тема', description: 'Описание' }] })),
      usage: { prompt_tokens: 4600, completion_tokens: 200, total_tokens: 4800, cost: 0.007, prompt_tokens_details: { cached_tokens: 3300 } },
    });

    await adaptiveTestingLlmService.extractCompetencies({ skillMd: '# Методичка', departmentName: null, positionName: null });

    // Позиция cached_tokens в INSERT — индекс 5 (session, purpose, model, prompt, completion, cached, ...).
    const okCall = pgExecute.mock.calls.find(c => (c[1] as unknown[])[7] === 'ok');
    expect((okCall?.[1] as unknown[])[5]).toBe(3300);
  });

  it('методичка уходит в запрос целиком', async () => {
    chatMock.mockResolvedValueOnce(llmResponse(JSON.stringify({
      competencies: [{ key: 'a1', name: 'Тема', description: 'Описание' }],
    })));

    await adaptiveTestingLlmService.extractCompetencies({
      skillMd: '# УНИКАЛЬНЫЙ_МАРКЕР методички',
      departmentName: null,
      positionName: null,
    });

    const payload = chatMock.mock.calls[0][0] as { messages: { content: string }[] };
    expect(payload.messages[1].content).toContain('УНИКАЛЬНЫЙ_МАРКЕР');
  });
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

  it('содержимое загруженного .md попадает в промпт вместе с обязанностями', async () => {
    chatMock.mockResolvedValue(llmResponse(JSON.stringify({
      question_text: 'Каков порядок оформления заявки на закупку материалов?',
      options: [{ id: 'a', text: '1' }, { id: 'b', text: '2' }, { id: 'c', text: '3' }],
      correct_option_ids: ['a'],
      rubric: null,
    })));

    await adaptiveTestingLlmService.generateQuestion({
      sessionId: 's1',
      snapshot: {
        ...SNAPSHOT,
        skillMd: '# Методичка отдела\n\nПравило эскалации: уведомить руководителя за 2 часа.',
        skillMdFilename: 'skill.md',
      },
      competency: SNAPSHOT.competencies[0],
      difficulty: 1,
      type: 'single',
      seq: 1,
      askedQuestions: [],
      gapTags: [],
    });

    const payload = chatMock.mock.calls[0][0];
    const duties = JSON.parse(payload.messages[1].content as string).duties as string;
    expect(duties).toContain(SNAPSHOT.dutiesText);
    expect(duties).toContain('Правило эскалации');
    expect(duties).toContain('skill.md');
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

    // Порядок параметров INSERT: session, purpose, model, prompt, completion, cached, cost, status.
    const statuses = pgExecute.mock.calls.map(c => (c[1] as unknown[])[7]);
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
