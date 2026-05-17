import type { FC } from 'react';
import { useCardReaderAgent } from '../../contexts/CardReaderAgentContext';
import './SigurHeaderBadges.css';

export const CardReaderHeaderBadge: FC = () => {
  const { connected } = useCardReaderAgent();
  return (
    <div className="sigur-header-badges" aria-label="Статус считывателя">
      <span className={`sigur-header-badge sigur-header-badge--${connected ? 'active' : 'inactive'}`}>
        <span className="sigur-header-badge__dot" />
        {connected ? 'Агент запущен' : 'Агент не запущен'}
      </span>
    </div>
  );
};
