import { type FC } from 'react';
import { cx } from '../../utils/motion';
import styles from './AnimatedNumber.module.css';

interface IAnimatedNumberProps {
  /** Отображаемое значение (число или предформатированная строка). */
  value: number | string;
  /** Класс на внешнюю обёртку (наследует типографику родителя). */
  className?: string;
}

/**
 * transitions.dev «Number pop-in»: при изменении value внутренний span
 * перемонтируется (через key), заново проигрывая CSS-анимацию blur+slide.
 * Без библиотек, без таймеров — анимация чисто на compositor.
 */
export const AnimatedNumber: FC<IAnimatedNumberProps> = ({ value, className }) => {
  return (
    <span className={cx(styles.wrap, className)}>
      <span key={String(value)} className={styles.value}>
        {value}
      </span>
    </span>
  );
};
