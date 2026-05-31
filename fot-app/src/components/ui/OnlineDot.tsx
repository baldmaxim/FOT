import { type FC } from 'react';
import styles from './OnlineDot.module.css';

interface IOnlineDotProps {
  online: boolean;
  title?: string;
  className?: string;
}

// Зелёная точка «в сети на портале». Офлайн — не рендерится (без сдвига макета).
export const OnlineDot: FC<IOnlineDotProps> = ({ online, title = 'В сети', className }) => {
  if (!online) return null;
  return (
    <span
      className={className ? `${styles.dot} ${className}` : styles.dot}
      title={title}
      aria-label={title}
      role="img"
    />
  );
};
