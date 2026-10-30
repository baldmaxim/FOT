import type { FC } from 'react';

import styles from './SupplementListsBar.module.css';

interface ISupplementListsBarProps {
  onOpenPlanned: () => void;
  onOpenApartments: () => void;
}

/**
 * Справа от поиска в «Доплате»: «Список:» и кнопки списков назначений — «Плановые доплаты» и «Квартира». Без иконок:
 * с ними панель на 1280px не влезает в строку — месяц, «Экспорт» и «Добавить сотрудника» уходят вниз.
 */
export const SupplementListsBar: FC<ISupplementListsBarProps> = ({ onOpenPlanned, onOpenApartments }) => (
  <div className={styles.bar} role="group" aria-label="Списки">
    <span className={styles.caption}>Список:</span>
    <button type="button" className={styles.button} onClick={onOpenPlanned}>Плановые доплаты</button>
    <button type="button" className={styles.button} onClick={onOpenApartments}>Квартира</button>
  </div>
);
