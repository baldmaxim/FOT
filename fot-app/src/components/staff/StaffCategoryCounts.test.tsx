import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaffCategoryCounts } from './StaffCategoryCounts';

const COUNTS = { total: 1151, itr: 569, worker: 582 };

/** Текст разметки без тегов и служебных комментариев React. */
const textOf = (html: string): string => html.replace(/<!-- -->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const render = (category: 'itr' | 'worker' | null, variant: 'header' | 'row') => renderToStaticMarkup(
  <StaffCategoryCounts counts={COUNTS} category={category} onSelect={() => undefined} variant={variant} />,
);

describe('StaffCategoryCounts', () => {
  it('шапка: «Все 1151 · ИТР 569 · Рабочие 582» — без «Остальных» и без подсказок при наведении', () => {
    const html = render(null, 'header');
    expect(textOf(html)).toBe('Все 1151 · ИТР 569 · Рабочие 582');
    expect(html).not.toContain('title=');
    expect(html).not.toContain('Остальные');
  });

  it('чипы под фильтрами: те же три кнопки, без разделителей и подсказок', () => {
    const html = render('itr', 'row');
    expect(textOf(html)).toBe('Все 1151 ИТР 569 Рабочие 582');
    expect(html).not.toContain('title=');
  });

  it('подсвечена выбранная группа, без группы — «Все»', () => {
    const pressed = (html: string): string[] => [...html.matchAll(/aria-pressed="true"[^>]*>([^<]*(?:<!-- -->[^<]*)*)</g)]
      .map(match => match[1].replace(/<!-- -->/g, '').trim());
    expect(pressed(render(null, 'header'))).toEqual(['Все 1151']);
    expect(pressed(render('itr', 'header'))).toEqual(['ИТР 569']);
    expect(pressed(render('worker', 'row'))).toEqual(['Рабочие 582']);
  });
});
