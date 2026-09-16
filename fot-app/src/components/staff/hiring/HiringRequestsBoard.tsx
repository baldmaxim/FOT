import { useMemo, useState, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus, Users2 } from 'lucide-react';
import { hiringRequestService, stageMeta, type HiringStage } from '../../../services/hiringRequestService';
import { HiringRequestCreateModal } from './HiringRequestCreateModal';
import { HiringRequestPanel } from './HiringRequestPanel';
import { RecruiterPoolModal } from './RecruiterPoolModal';
import { HiringAnalytics } from './HiringAnalytics';
import { HiringDepartmentGroups } from './HiringDepartmentGroups';
import styles from './hiring.module.css';

export const HIRING_QK = ['hiring-requests'];

const isArchived = (stage: HiringStage): boolean => stage === 'closed' || stage === 'cancelled';

interface IHiringRequestsBoardProps {
  /** Добавляет внешние отступы — для standalone-использования в ЛК (EmployeeLayout не пэддит контент). */
  padded?: boolean;
}

export const HiringRequestsBoard: FC<IHiringRequestsBoardProps> = ({ padded = false }) => {
  const [stageFilter, setStageFilter] = useState<HiringStage | 'all' | 'archive'>('all');
  const [view, setView] = useState<'board' | 'analytics'>('board');
  const [createOpen, setCreateOpen] = useState(false);
  const [poolOpen, setPoolOpen] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: HIRING_QK,
    queryFn: () => hiringRequestService.list(),
    staleTime: 20_000,
  });
  const requests = data?.data ?? [];
  const caps = data?.meta ?? { can_manage: false, is_recruiter: false, can_create: false };

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of requests) c[r.stage] = (c[r.stage] ?? 0) + 1;
    return c;
  }, [requests]);

  const open = requests.filter(r => r.stage !== 'closed' && r.stage !== 'rework' && r.stage !== 'cancelled').length;
  const closed = requests.filter(r => r.stage === 'closed').length;
  const rework = requests.filter(r => r.stage === 'rework').length;
  const avgDays = closed > 0
    ? Math.round(requests.filter(r => r.stage === 'closed').reduce((a, r) => a + r.days_in_work, 0) / closed)
    : null;

  // Закрытые и отменённые видны только в «Архиве».
  const archivedCount = requests.filter(r => isArchived(r.stage)).length;
  const activeCount = requests.length - archivedCount;
  const cards = requests.filter(r => {
    if (stageFilter === 'archive') return isArchived(r.stage);
    if (isArchived(r.stage)) return false;
    return stageFilter === 'all' || r.stage === stageFilter;
  });

  if (view === 'analytics') {
    return (
      <div className={`${styles.wrap}${padded ? ' ' + styles.padded : ''}`}>
        <div className={styles.toolbar}>
          <div className={styles.viewSwitch}>
            <button onClick={() => setView('board')}>Доска</button>
            <button className={styles.on} onClick={() => setView('analytics')}>Аналитика</button>
          </div>
        </div>
        <HiringAnalytics />
      </div>
    );
  }

  return (
    <div className={`${styles.wrap}${padded ? ' ' + styles.padded : ''}`}>
      <div className={styles.toolbar}>
        <div className={styles.toolbarLeft}>
          {caps.can_manage && (
            <div className={styles.viewSwitch}>
              <button className={styles.on}>Доска</button>
              <button onClick={() => setView('analytics')}>Аналитика</button>
            </div>
          )}
          {caps.can_manage && (
            <button className={styles.btnGhost} onClick={() => setPoolOpen(true)}>
              <Users2 size={14} /> Команда подбора
            </button>
          )}
        </div>
        {caps.can_create && (
          <button className={styles.btnCreate} onClick={() => setCreateOpen(true)}>
            <Plus size={16} /> Создать заявку на поиск сотрудника
          </button>
        )}
      </div>

      <div className={styles.strip}>
        <span className={styles.it}><b>{requests.length}</b> {caps.can_manage ? 'всего' : 'заявок'}</span>
        <span className={styles.sep}>·</span>
        <span className={styles.it}><b>{open}</b> открыто</span>
        <span className={styles.sep}>·</span>
        <span className={styles.it}><b>{closed}</b> закрыто</span>
        <span className={styles.sep}>·</span>
        <span className={styles.it}>средний срок <b>{avgDays == null ? '—' : `${avgDays} дн`}</b></span>
        {rework > 0 && <>
          <span className={styles.sep}>·</span>
          <span className={styles.it} style={{ color: 'var(--error)' }}><b>{rework}</b> на доработке</span>
        </>}
      </div>

      <div className={styles.stages}>
        <button className={`${styles.scount} ${stageFilter === 'all' ? styles.on : ''}`} onClick={() => setStageFilter('all')}>
          <span className={styles.d} style={{ background: 'var(--text-secondary)' }} />Все <span className={styles.n}>{activeCount}</span>
        </button>
        {(['new', 'in_progress', 'interview', 'offer', 'rework'] as HiringStage[]).map(s => {
          if (!counts[s]) return null;
          const m = stageMeta(s);
          return (
            <button key={s} className={`${styles.scount} ${stageFilter === s ? styles.on : ''}`} style={{ color: m.color }} onClick={() => setStageFilter(s)}>
              <span className={styles.d} style={{ background: m.color }} />{m.label} <span className={styles.n}>{counts[s]}</span>
            </button>
          );
        })}
        {archivedCount > 0 && (
          <button className={`${styles.scount} ${stageFilter === 'archive' ? styles.on : ''}`} style={{ color: 'var(--success)' }} onClick={() => setStageFilter('archive')}>
            <span className={styles.d} style={{ background: 'var(--success)' }} />Архив <span className={styles.n}>{archivedCount}</span>
          </button>
        )}
      </div>

      {isLoading ? (
        <div className={styles.empty}>Загрузка…</div>
      ) : cards.length === 0 ? (
        <div className={styles.empty}>Нет заявок в этом фильтре.</div>
      ) : (
        <HiringDepartmentGroups requests={cards} onOpen={setOpenId} />
      )}

      <div className={styles.legend}>
        Клик по строке — рабочая панель: воронка кандидатов, ссылки HH, файлы, комментарии, переключатель этапа.
      </div>

      {createOpen && <HiringRequestCreateModal onClose={() => setCreateOpen(false)} />}
      {poolOpen && <RecruiterPoolModal onClose={() => setPoolOpen(false)} />}
      {openId != null && (
        <HiringRequestPanel
          requestId={openId}
          canManage={caps.can_manage}
          onClose={() => setOpenId(null)}
        />
      )}
    </div>
  );
};
