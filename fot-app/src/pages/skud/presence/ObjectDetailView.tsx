import { type FC, useState, type ReactNode } from 'react';
import { MapPinIcon } from '../../../components/ui/Icons';
import type { IPresenceObjectBucket } from '../../../types';
import { CompanyGroup } from './CompanyGroup';
import styles from './SkudPresencePage.module.css';

interface IObjectDetailViewProps {
  bucket: IPresenceObjectBucket;
  /** Слот в правую часть шапки — например, кнопка «×» в модалке. */
  headerRight?: ReactNode;
  /** Доп. CSS-класс для корневого блока (для full-page-mode). */
  className?: string;
}

export const ObjectDetailView: FC<IObjectDetailViewProps> = ({ bucket, headerRight, className }) => {
  const [expanded, setExpanded] = useState<Set<string>>(() =>
    // Если в bucket'е только одна компания — разворачиваем её сразу.
    bucket.companies.length === 1 ? new Set([bucket.companies[0].company_id]) : new Set(),
  );

  const toggle = (companyId: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(companyId)) next.delete(companyId);
      else next.add(companyId);
      return next;
    });
  };

  return (
    <div className={className ? `${styles.modal} ${className}` : styles.modal}>
      <header className={styles.modalHeader}>
        <div className={styles.modalTitle}>
          <MapPinIcon className={styles.cardIcon} />
          <span>{bucket.object_name}</span>
          <span className={styles.modalBadge}>{bucket.online_count} чел.</span>
        </div>
        {headerRight}
      </header>
      <div className={styles.modalBody}>
        {bucket.companies.length === 0 ? (
          <div className={styles.cardEmpty}>Сейчас никого нет</div>
        ) : (
          bucket.companies.map(company => (
            <CompanyGroup
              key={company.company_id}
              company={company}
              isExpanded={expanded.has(company.company_id)}
              onToggle={() => toggle(company.company_id)}
            />
          ))
        )}
      </div>
    </div>
  );
};
