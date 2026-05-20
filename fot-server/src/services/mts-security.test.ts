import { describe, it, expect } from 'vitest';
import { assertMtsBaseUrlAllowed } from './settings.service.js';

describe('MTS base URL allow-list (защита от SSRF)', () => {
  it('пропускает api.mpoisk.ru с https', () => {
    expect(() => assertMtsBaseUrlAllowed('https://api.mpoisk.ru/v6/api')).not.toThrow();
    expect(() => assertMtsBaseUrlAllowed('https://api.mpoisk.ru')).not.toThrow();
  });

  it('отклоняет http (только https)', () => {
    expect(() => assertMtsBaseUrlAllowed('http://api.mpoisk.ru/v6/api')).toThrow(/https/);
  });

  it('отклоняет посторонний хост (увод токена)', () => {
    expect(() => assertMtsBaseUrlAllowed('https://attacker.example.com/v6/api')).toThrow(/allow-list/);
    expect(() => assertMtsBaseUrlAllowed('https://api.mpoisk.ru.attacker.com')).toThrow(/allow-list/);
    expect(() => assertMtsBaseUrlAllowed('https://localhost:9999/v6/api')).toThrow(/allow-list/);
    expect(() => assertMtsBaseUrlAllowed('https://169.254.169.254/')).toThrow(/allow-list/);
  });

  it('отклоняет мусор', () => {
    expect(() => assertMtsBaseUrlAllowed('not a url')).toThrow(/невалидный/);
    expect(() => assertMtsBaseUrlAllowed('javascript:alert(1)')).toThrow();
    expect(() => assertMtsBaseUrlAllowed('file:///etc/passwd')).toThrow();
  });
});
