import { describe, expect, it } from 'vitest';

/**
 * Детектор внешних правок Sigur: сравнение обязательного набора отделов с
 * зеркалом. Ключевое требование — направленность: лишние активные строки в
 * зеркале (отделы, оставленные ради сотрудников, safety-предки) расхождением
 * не считаются, иначе тик уходил бы в вечный refresh.
 */
import { diffMirror, hashSnapshot, isDriftEmpty, type IMirrorRow } from './sigur-structure-watch.service.js';
import { resolveMirrorPolicy, type INormalizedDept } from './sigur-sync-shared.js';

const dept = (id: number, name: string, parentId: number | null = null): INormalizedDept => ({
  id,
  name,
  parentId,
});

const mirrorRow = (id: number, name: string, parentSigurId: number | null = null): IMirrorRow => ({
  sigur_department_id: id,
  name,
  parent_sigur_id: parentSigurId,
});

describe('resolveMirrorPolicy', () => {
  const departments = [
    dept(1, 'СУ-10'),
    dept(2, 'Отдел закупок', 1),
    dept(3, 'Новый департамент', 1),
    dept(6, 'Чужая компания'),
  ];

  it('без фильтра зеркалит и разрешает всё дерево Sigur', () => {
    const { mirroredIds, assignableIds } = resolveMirrorPolicy(departments, null);

    expect([...mirroredIds].sort((a, b) => a - b)).toEqual([1, 2, 3, 6]);
    expect([...assignableIds].sort((a, b) => a - b)).toEqual([1, 2, 3, 6]);
  });

  it('раскрывает whitelist вниз: новый дочерний отдел зеркалится и назначаем', () => {
    const { mirroredIds, assignableIds } = resolveMirrorPolicy(departments, new Set([1]));

    expect(mirroredIds.has(3)).toBe(true);
    expect(assignableIds.has(3)).toBe(true);
    expect(mirroredIds.has(6)).toBe(false);
  });

  it('структурный предок зеркалится, но назначать в него нельзя', () => {
    const nested = [dept(1, 'Компания'), dept(2, 'Департамент', 1), dept(3, 'Отдел', 2)];
    const { mirroredIds, assignableIds } = resolveMirrorPolicy(nested, new Set([3]));

    expect([...mirroredIds].sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect([...assignableIds]).toEqual([3]);
    expect(assignableIds.has(1)).toBe(false);
  });
});

describe('diffMirror', () => {
  it('не видит расхождения, когда зеркало содержит лишние строки', () => {
    const expected = [dept(1, 'СУ-10'), dept(2, 'Отдел', 1)];
    const mirror = [
      mirrorRow(1, 'СУ-10'),
      mirrorRow(2, 'Отдел', 1),
      // Отдел вне фильтра, оставленный ради числящихся сотрудников.
      mirrorRow(99, 'Секретариат', 1),
    ];

    expect(isDriftEmpty(diffMirror(expected, mirror))).toBe(true);
  });

  it('видит отсутствующий, переименованный и переехавший отделы', () => {
    const expected = [
      dept(1, 'СУ-10'),
      dept(2, 'Отдел закупок', 1),
      dept(3, 'Новый', 1),
      dept(4, 'Переехавший', 3),
    ];
    const mirror = [
      mirrorRow(1, 'СУ-10'),
      mirrorRow(2, 'Отдел снабжения', 1),
      mirrorRow(4, 'Переехавший', 1),
    ];

    const drift = diffMirror(expected, mirror);

    expect(drift.missing).toEqual([3]);
    expect(drift.renamed).toEqual([2]);
    expect(drift.reparented).toEqual([4]);
    expect(isDriftEmpty(drift)).toBe(false);
  });

  it('корень Sigur под синтетическим «Объект» расхождением не считается', () => {
    const expected = [dept(1, 'СУ-10', 0)];
    // parent_sigur_id = null: родитель в зеркале — «Объект», у него нет sigur-id.
    expect(isDriftEmpty(diffMirror(expected, [mirrorRow(1, 'СУ-10', null)]))).toBe(true);
  });
});

describe('hashSnapshot', () => {
  it('не зависит от порядка отделов в ответе Sigur', () => {
    const a = [dept(2, 'Б', 1), dept(1, 'А')];
    const b = [dept(1, 'А'), dept(2, 'Б', 1)];

    expect(hashSnapshot(a)).toBe(hashSnapshot(b));
  });

  it('меняется при переименовании и смене родителя', () => {
    const base = [dept(1, 'А'), dept(2, 'Б', 1)];

    expect(hashSnapshot(base)).not.toBe(hashSnapshot([dept(1, 'А'), dept(2, 'В', 1)]));
    expect(hashSnapshot(base)).not.toBe(hashSnapshot([dept(1, 'А'), dept(2, 'Б', null)]));
  });
});
