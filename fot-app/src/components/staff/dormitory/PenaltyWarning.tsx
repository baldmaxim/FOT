import type { FC } from 'react';

import type { IPenaltyMatch } from '../../../services/dormitoryService';
import { PENALTY_WARNING_TITLES, penaltyItemText } from '../../../utils/dormitoryPenalties';
import styles from './DormitoryTab.module.css';

interface IPenaltyWarningProps {
  /** Есть хоть одно взыскание (level не null). */
  match: IPenaltyMatch;
}

/**
 * «Заселить» общежития (миграция 378): взыскания выбранного сотрудника — «Есть взыскания — заселять не нужно» или
 * «Проверьте» (взыскание у человека с тем же ФИО) и список «дата · источник · информация». Только предупреждение.
 */
export const PenaltyWarning: FC<IPenaltyWarningProps> = ({ match }) => {
  if (!match.level) return null;
  return (
    <div className={styles.penaltyWarning} role="status">
      <strong>{PENALTY_WARNING_TITLES[match.level]}</strong>
      {match.items.length > 0 && (
        <ul>
          {/* Своего ключа у записи в ответе нет: порядок стабилен (сервер сортирует), список только для чтения. */}
          {match.items.map((item, index) => <li key={index}>{penaltyItemText(item)}</li>)}
        </ul>
      )}
    </div>
  );
};
