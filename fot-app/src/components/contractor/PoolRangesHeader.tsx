import { type FC } from 'react';
import { useQuery } from '@tanstack/react-query';
import { contractorAdminService } from '../../services/contractorService';
import styles from '../../pages/contractor/Contractor.module.css';

export const PoolRangesHeader: FC = () => {
  const q = useQuery({
    queryKey: ['contractor-pool-ranges'],
    queryFn: () => contractorAdminService.getPoolRanges(),
    staleTime: 15_000,
    refetchInterval: 15_000,
  });

  if (q.isLoading) return <div className={styles.statusNote}>Диапазоны: загрузка…</div>;
  const data = q.data ?? { ranges: [], totals: { free: 0, occupied: 0 } };
  if (data.ranges.length === 0) {
    return <div className={styles.statusNote}>Диапазоны пула пусты</div>;
  }

  return (
    <div style={{ marginTop: 12, marginBottom: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
        <span className={styles.title} style={{ fontSize: 14 }}>Диапазоны пула</span>
        <span className={styles.statusNote}>
          Свободно: <b style={{ color: 'var(--success)' }}>{data.totals.free}</b>
          {' · '}
          Занято: <b style={{ color: 'var(--error)' }}>{data.totals.occupied}</b>
        </span>
      </div>
      <div className={styles.rangeChips}>
        {data.ranges.map((r, i) => {
          const label = r.from === r.to ? r.from : `${r.from}–${r.to}`;
          const cls = r.status === 'free' ? styles.rangeChipFree : styles.rangeChipOccupied;
          return (
            <span
              key={`${r.from}-${r.to}-${i}`}
              className={`${styles.rangeChip} ${cls}`}
              title={`${r.count} ${r.status === 'free' ? 'свободных' : 'занятых'}`}
            >
              {label}
            </span>
          );
        })}
      </div>
    </div>
  );
};

export default PoolRangesHeader;
