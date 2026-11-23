import type { FC } from 'react';

import styles from '../../ui/registry/RegistryFormModal.module.css';

interface IDormitorySelectProps {
  id: string;
  /** Названия общежитий справочника (миграция 377). */
  options: readonly string[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
  /** Не предлагать (общежитие, откуда переселяют). */
  exclude?: string | null;
}

const sameName = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Выбор общежития из справочника (миграция 377) — вместо ввода текста: опечатка или «новое» общежитие не появятся,
 * новое сначала добавляют в «Справочник». Старое название записи, которого в справочнике нет, остаётся в списке —
 * правка дат такой записи не ломается.
 */
export const DormitorySelect: FC<IDormitorySelectProps> = ({
  id, options, value, onChange, disabled = false, invalid = false, describedBy, exclude = null,
}) => {
  const list = options.filter(option => !exclude || !sameName(option, exclude));
  const legacy = value && !list.some(option => sameName(option, value)) ? [value] : [];
  return (
    <select
      id={id}
      className={styles.select}
      value={list.find(option => sameName(option, value)) ?? value}
      onChange={event => onChange(event.target.value)}
      disabled={disabled}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
    >
      <option value="">Выберите общежитие</option>
      {[...legacy, ...list].map(option => <option key={option} value={option}>{option}</option>)}
    </select>
  );
};
