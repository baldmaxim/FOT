import { describe, expect, it } from 'vitest';

import { evaluateAutoFireSafety } from './sigur-sync-employees.service.js';

describe('evaluateAutoFireSafety', () => {
  it('пропускает обычный fire ниже лимита', () => {
    const r = evaluateAutoFireSafety(2400, 2400, 5);
    expect(r.shouldSkip).toBe(false);
    expect(r.reason).toBeNull();
  });

  it('блокирует fire при усечённой выгрузке Sigur (< 50% активных)', () => {
    const r = evaluateAutoFireSafety(2400, 1000, 50);
    expect(r.shouldSkip).toBe(true);
    expect(r.reason).toContain('looks truncated');
  });

  it('пропускает fire, если выгрузка точно совпадает с активными', () => {
    const r = evaluateAutoFireSafety(2400, 2400, 1);
    expect(r.shouldSkip).toBe(false);
  });

  it('блокирует fire при превышении абсолютного лимита по умолчанию (20)', () => {
    const r = evaluateAutoFireSafety(100, 100, 21);
    expect(r.shouldSkip).toBe(true);
    expect(r.reason).toContain('exceeds limit 20');
  });

  it('пропускает fire ровно на абсолютном лимите', () => {
    const r = evaluateAutoFireSafety(100, 100, 20);
    expect(r.shouldSkip).toBe(false);
  });

  it('повышает лимит до 5% активных, если 5% больше абсолютного', () => {
    // 5% от 1000 = 50, при absoluteLimit=20 итоговый лимит = 50
    const r = evaluateAutoFireSafety(1000, 1000, 45);
    expect(r.shouldSkip).toBe(false);
    expect(r.limit).toBe(50);
  });

  it('блокирует fire при превышении относительного лимита 5%', () => {
    const r = evaluateAutoFireSafety(1000, 1000, 60);
    expect(r.shouldSkip).toBe(true);
    expect(r.reason).toContain('exceeds limit 50');
  });

  it('уважает кастомный absoluteLimit (env SIGUR_AUTOFIRE_MAX)', () => {
    const r = evaluateAutoFireSafety(50, 50, 5, { absoluteLimit: 3 });
    expect(r.shouldSkip).toBe(true);
    expect(r.limit).toBe(Math.max(3, Math.ceil(50 * 0.05)));
  });

  it('truncationRatio 0 отключает проверку усечения', () => {
    const r = evaluateAutoFireSafety(2400, 0, 0, { truncationRatio: 0 });
    expect(r.shouldSkip).toBe(false);
  });

  it('пустая БД (activeWithSigur=0) не падает на проверке усечения', () => {
    const r = evaluateAutoFireSafety(0, 0, 0);
    expect(r.shouldSkip).toBe(false);
  });

  it('воспроизводит инцидент 17.04: fire 12 при ~2400 активных пропускался, теперь блокируется', () => {
    // Активных ~2400, лимит = max(20, ceil(2400*0.05)=120) = 120 → 12 проходит.
    // Здесь воспроизводим именно превышение порога — 130 шт. блокируется.
    const r = evaluateAutoFireSafety(2400, 2400, 130);
    expect(r.shouldSkip).toBe(true);
    expect(r.limit).toBe(120);
  });
});
