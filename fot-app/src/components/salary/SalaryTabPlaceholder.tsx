import type { FC } from 'react';
import { Clock } from 'lucide-react';

import styles from './SalaryTabPlaceholder.module.css';

interface ISalaryTabPlaceholderProps {
  title: string;
  /** Что появится во вкладке — чтобы было понятно, чего ждать, а не «пустая форма». */
  description: string;
  stage: string;
}

/**
 * Пустое состояние вкладки раздела «Зарплата», которая ещё не реализована.
 * Честно говорит, что будет и когда, вместо формы без действия.
 */
export const SalaryTabPlaceholder: FC<ISalaryTabPlaceholderProps> = ({ title, description, stage }) => (
  <div className={styles.placeholder}>
    <Clock size={28} aria-hidden="true" className={styles.icon} />
    <h2 className={styles.title}>{title}</h2>
    <p className={styles.description}>{description}</p>
    <span className={styles.stage}>{stage}</span>
  </div>
);
