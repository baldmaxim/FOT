import { describe, expect, it, vi } from 'vitest';

const { pgQueryOne } = vi.hoisted(() => ({ pgQueryOne: vi.fn() }));

vi.mock('../config/postgres.js', () => ({
  query: vi.fn(),
  queryOne: pgQueryOne,
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock('./settings.service.js', () => ({
  settingsService: {
    getAdaptiveTestingSettings: vi.fn(),
    getResolvedAdaptiveLlmConfig: vi.fn(),
  },
}));

vi.mock('./adaptive-testing-llm.service.js', () => ({
  ADAPTIVE_PROMPT_VERSION: 'v1',
  adaptiveTestingLlmService: { generateQuestion: vi.fn(), evaluateTextAnswer: vi.fn() },
}));

import {
  adaptiveTestingService,
  adjustDifficulty,
  computeResultSummary,
  isEmailAllowed,
  profileInputZod,
  questionTypeForSeq,
  sanitizeSkillMd,
  scoreClosedAnswer,
  selectNextQuestion,
  validateAnswerPayload,
  SKILL_MD_MAX_CHARS,
} from './adaptive-testing.service.js';
import type { IAdaptiveCompetency, IAdaptiveCompetencyState } from '../types/adaptive-testing.types.js';

const OPTIONS = [
  { id: 'a', text: 'A' },
  { id: 'b', text: 'B' },
  { id: 'c', text: 'C' },
  { id: 'd', text: 'D' },
];

describe('isEmailAllowed (fail-closed allowlist)', () => {
  it('пустой/отсутствующий allowlist = никому', () => {
    expect(isEmailAllowed('', 'esenov.m.n@su10.ru')).toBe(false);
    expect(isEmailAllowed(null, 'esenov.m.n@su10.ru')).toBe(false);
    expect(isEmailAllowed('   ', 'esenov.m.n@su10.ru')).toBe(false);
  });

  it('«*» — всем (page access проверяется отдельно)', () => {
    expect(isEmailAllowed('*', 'any@x.ru')).toBe(true);
  });

  it('CSV с нормализацией регистра и пробелов', () => {
    expect(isEmailAllowed(' Esenov.M.N@su10.ru , other@x.ru', 'esenov.m.n@SU10.ru')).toBe(true);
    expect(isEmailAllowed('esenov.m.n@su10.ru', 'stranger@su10.ru')).toBe(false);
  });

  it('без email пользователя — запрет', () => {
    expect(isEmailAllowed('a@b.ru', null)).toBe(false);
  });
});

describe('validateAnswerPayload (strict)', () => {
  it('single: ровно один существующий вариант', () => {
    expect(validateAnswerPayload({ type: 'single', optionId: 'a' }, 'single', OPTIONS))
      .toEqual({ type: 'single', optionId: 'a' });
  });

  it('single: несуществующий вариант отклоняется', () => {
    expect(() => validateAnswerPayload({ type: 'single', optionId: 'z' }, 'single', OPTIONS)).toThrow();
  });

  it('single: два id (не тот тип) отклоняется', () => {
    expect(() => validateAnswerPayload({ type: 'multiple', optionIds: ['a', 'b'] }, 'single', OPTIONS)).toThrow();
  });

  it('неизвестные поля запрещены (strict)', () => {
    expect(() => validateAnswerPayload({ type: 'single', optionId: 'a', hack: 1 }, 'single', OPTIONS)).toThrow();
  });

  it('multiple: дубли схлопываются через Set', () => {
    const result = validateAnswerPayload({ type: 'multiple', optionIds: ['a', 'a', 'b'] }, 'multiple', OPTIONS);
    expect(result).toEqual({ type: 'multiple', optionIds: ['a', 'b'] });
  });

  it('multiple: чужой id отклоняется', () => {
    expect(() => validateAnswerPayload({ type: 'multiple', optionIds: ['a', 'zz'] }, 'multiple', OPTIONS)).toThrow();
  });

  it('text: лимит длины', () => {
    expect(() => validateAnswerPayload({ type: 'text', text: 'x'.repeat(4001) }, 'text', null)).toThrow();
    expect(validateAnswerPayload({ type: 'text', text: 'ответ' }, 'text', null)).toEqual({ type: 'text', text: 'ответ' });
  });
});

describe('scoreClosedAnswer', () => {
  it('single: 100 за правильный, 0 за неправильный', () => {
    expect(scoreClosedAnswer({ type: 'single', optionId: 'a' }, ['a'])).toBe(100);
    expect(scoreClosedAnswer({ type: 'single', optionId: 'b' }, ['a'])).toBe(0);
  });

  it('multiple: частичный балл, неправильные вычитаются', () => {
    // 2 правильных из 2, 1 неправильный: (2-1)/2 = 50
    expect(scoreClosedAnswer({ type: 'multiple', optionIds: ['a', 'b', 'c'] }, ['a', 'b'])).toBe(50);
  });

  it('multiple: повтор правильного id не даёт балл выше 100', () => {
    // Set в payload гарантирует дедуп, но и сам скоринг через Set + clamp
    expect(scoreClosedAnswer({ type: 'multiple', optionIds: ['a', 'a', 'a'] }, ['a'])).toBe(100);
  });

  it('multiple: не уходит ниже 0', () => {
    expect(scoreClosedAnswer({ type: 'multiple', optionIds: ['c', 'd'] }, ['a', 'b'])).toBe(0);
  });
});

describe('adjustDifficulty', () => {
  it('≥85 — вверх с потолком 3', () => {
    expect(adjustDifficulty(1, 90)).toBe(2);
    expect(adjustDifficulty(3, 100)).toBe(3);
  });
  it('60–84 — без изменения', () => {
    expect(adjustDifficulty(2, 70)).toBe(2);
  });
  it('<60 — вниз с полом 1', () => {
    expect(adjustDifficulty(2, 30)).toBe(1);
    expect(adjustDifficulty(1, 0)).toBe(1);
  });
});

describe('questionTypeForSeq (детерминированный микс)', () => {
  it('4 и 8 — text; 2 и 6 — multiple; остальные — single', () => {
    expect(questionTypeForSeq(4)).toBe('text');
    expect(questionTypeForSeq(8)).toBe('text');
    expect(questionTypeForSeq(2)).toBe('multiple');
    expect(questionTypeForSeq(6)).toBe('multiple');
    for (const seq of [1, 3, 5, 7, 9, 10]) expect(questionTypeForSeq(seq)).toBe('single');
  });
});

const COMPETENCIES: IAdaptiveCompetency[] = [
  { key: 'docs', name: 'Документы' },
  { key: 'escalation', name: 'Эскалация' },
  { key: 'safety', name: 'Безопасность' },
];

const st = (askedCount: number, scoreSum: number, nextDifficulty = 1, lastScore: number | null = null): IAdaptiveCompetencyState => ({
  askedCount, scoreSum, lastScore, nextDifficulty, consecutive: 0,
});

describe('selectNextQuestion', () => {
  it('первый вопрос — первая компетенция (tie-break по порядку профиля), сложность 1', () => {
    const spec = selectNextQuestion(COMPETENCIES, {}, [], 1);
    expect(spec.competency.key).toBe('docs');
    expect(spec.difficulty).toBe(1);
    expect(spec.seq).toBe(1);
  });

  it('обязательное продолжение слабой компетенции (score < 60, подряд < 2)', () => {
    const spec = selectNextQuestion(
      COMPETENCIES,
      { docs: st(1, 30, 1, 30) },
      [{ competencyKey: 'docs', score: 30 }],
      2,
    );
    expect(spec.competency.key).toBe('docs');
  });

  it('запрет 3-го вопроса подряд: слабая компетенция уступает другой', () => {
    const spec = selectNextQuestion(
      COMPETENCIES,
      { docs: st(2, 40, 1, 20) },
      [
        { competencyKey: 'docs', score: 20 },
        { competencyKey: 'docs', score: 20 },
      ],
      3,
    );
    expect(spec.competency.key).not.toBe('docs');
  });

  it('avgScore непокрытой = 50: сильно проваленная покрытая приоритетнее непокрытой', () => {
    // docs: avg 0 → priority 0.5*100 + 0.15*50 = 57.5; непокрытые: 0.5*50+0.35*100+0.15*100 = 75
    // Непокрытая выигрывает; после двух подряд по docs выбор идёт из непокрытых по порядку.
    const spec = selectNextQuestion(
      COMPETENCIES,
      { docs: st(2, 0, 1, 0) },
      [
        { competencyKey: 'docs', score: 0 },
        { competencyKey: 'docs', score: 0 },
      ],
      3,
    );
    expect(spec.competency.key).toBe('escalation');
  });

  it('возврат к компетенции — по сохранённому nextDifficulty', () => {
    const spec = selectNextQuestion(
      COMPETENCIES,
      {
        docs: st(1, 90, 2, 90),
        escalation: st(1, 95, 2, 95),
        safety: st(1, 95, 2, 95),
      },
      [
        { competencyKey: 'docs', score: 90 },
        { competencyKey: 'escalation', score: 95 },
        { competencyKey: 'safety', score: 95 },
      ],
      5,
    );
    expect(spec.difficulty).toBe(2);
  });
});

describe('sanitizeSkillMd', () => {
  const BOM = String.fromCharCode(0xfeff);
  const NUL = String.fromCharCode(0);

  it('срезает BOM и нулевые байты, нормализует CRLF', () => {
    const raw = BOM + '# Заголовок\r\nстрока' + NUL + ' два\r\n';
    const clean = sanitizeSkillMd(raw);
    expect(clean).toBe('# Заголовок\nстрока два');
    expect(clean).not.toContain(BOM);
    expect(clean).not.toContain(NUL);
    expect(clean).not.toContain('\r');
  });

  it('сохраняет табуляцию и переводы строк внутри текста', () => {
    expect(sanitizeSkillMd('a\tb\nc')).toBe('a\tb\nc');
  });
});

describe('profileInputZod — файл скилла (.md)', () => {
  const base = {
    orgDepartmentId: '11111111-1111-1111-1111-111111111111',
    positionId: null,
    title: 'Профиль',
    competencies: [{ key: 'docs', name: 'Документы' }],
    isPublished: true,
  };

  it('файл предельного размера проходит, на символ больше — отклоняется', () => {
    const atLimit = 'x'.repeat(SKILL_MD_MAX_CHARS);
    expect(() => profileInputZod.parse({
      ...base, dutiesText: '', skillMd: atLimit, skillMdFilename: 'skill.md',
    })).not.toThrow();

    expect(() => profileInputZod.parse({
      ...base, dutiesText: '', skillMd: `${atLimit}x`, skillMdFilename: 'skill.md',
    })).toThrow();
  });

  it('публикация без обязанностей, но с файлом — проходит', () => {
    expect(() => profileInputZod.parse({
      ...base, dutiesText: '', skillMd: '# Методичка отдела', skillMdFilename: 'skill.md',
    })).not.toThrow();
  });

  it('публикация без обязанностей и без файла — отклоняется', () => {
    expect(() => profileInputZod.parse({ ...base, dutiesText: '' })).toThrow(/Обязанности|файл/i);
  });

  it('публикация только с обязанностями (без файла) — проходит', () => {
    expect(() => profileInputZod.parse({
      ...base, dutiesText: 'Оформляет заявки, ведёт реестр закупок.',
    })).not.toThrow();
  });

  it('файл без имени — отклоняется', () => {
    expect(() => profileInputZod.parse({
      ...base, dutiesText: '', skillMd: '# Методичка',
    })).toThrow(/имя загруженного файла/i);
  });

  it('обязанности по-прежнему ограничены 8000 символами', () => {
    expect(() => profileInputZod.parse({
      ...base, dutiesText: 'д'.repeat(8001),
    })).toThrow();
  });
});

describe('saveProfile — дубль скоупа', () => {
  const input = {
    orgDepartmentId: '11111111-1111-1111-1111-111111111111',
    positionId: null,
    title: 'Профиль отдела',
    dutiesText: 'Обязанности отдела, достаточно длинные.',
    competencies: [{ key: 'docs', name: 'Документы' }],
    isPublished: true,
  };

  it('нарушение уникальности превращается в понятную 409, а не в 500', async () => {
    pgQueryOne.mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: '23505' }));

    await expect(adaptiveTestingService.saveProfile(input, 'user-1'))
      .rejects.toMatchObject({ httpStatus: 409, code: 'profile_exists' });
  });

  it('прочие ошибки БД пробрасываются как есть', async () => {
    pgQueryOne.mockRejectedValueOnce(Object.assign(new Error('connection lost'), { code: '08006' }));

    await expect(adaptiveTestingService.saveProfile(input, 'user-1'))
      .rejects.toThrow('connection lost');
  });
});

describe('computeResultSummary', () => {
  it('overall — среднее по покрытым компетенциям, coverage по всем', () => {
    const summary = computeResultSummary(COMPETENCIES, {
      docs: st(2, 160), // avg 80 → сильная
      escalation: st(2, 100), // avg 50 → слабая
      // safety не покрыта
    });
    expect(summary.overallScore).toBe(65);
    expect(summary.coveragePct).toBe(67);
    expect(summary.strengths).toEqual(['Документы']);
    expect(summary.weaknesses).toEqual(['Эскалация']);
    expect(summary.recommendations[0]).toContain('Эскалация');
  });

  it('непокрытые компетенции не тянут overall вниз', () => {
    const summary = computeResultSummary(COMPETENCIES, { docs: st(1, 100) });
    expect(summary.overallScore).toBe(100);
    expect(summary.coveragePct).toBe(33);
  });

  it('пустое состояние — нули без исключений', () => {
    const summary = computeResultSummary(COMPETENCIES, {});
    expect(summary.overallScore).toBe(0);
    expect(summary.coveragePct).toBe(0);
  });
});
