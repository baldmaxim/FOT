import { useMemo, useState, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus, Users2 } from 'lucide-react';
import {
  hiringRequestService, FUNNEL_KEYS, stageMeta,
  type IHiringRequest, type HiringStage,
} from '../../../services/hiringRequestService';
import { HiringRequestCreateModal } from './HiringRequestCreateModal';
import { HiringRequestPanel } from './HiringRequestPanel';
import { RecruiterPoolModal } from './RecruiterPoolModal';
import { HiringAnalytics } from './HiringAnalytics';
import { Avatar, pluralDays, fmtDate } from './hiringUi';
import styles from './hiring.module.css';

export const HIRING_QK = ['hiring-requests'];

interface IHiringRequestsBoardProps {
  /** Добавляет внешние отступы — для standalone-использования в ЛК (EmployeeLayout не пэддит контент). */
  padded?: boolean;
}

export const HiringRequestsBoard: FC<IHiringRequestsBoardProps> = ({ padded = false }) => {
  const [stageFilter, setStageFilter] = useState<HiringStage | 'all'>('all');
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

  const cards = requests.filter(r => stageFilter === 'all' || r.stage === stageFilter);

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
          <span className={styles.d} style={{ background: 'var(--text-secondary)' }} />Все <span className={styles.n}>{requests.length}</span>
        </button>
        {(['new', 'in_progress', 'interview', 'offer', 'closed', 'rework'] as HiringStage[]).map(s => {
          if (!counts[s]) return null;
          const m = stageMeta(s);
          return (
            <button key={s} className={`${styles.scount} ${stageFilter === s ? styles.on : ''}`} style={{ color: m.color }} onClick={() => setStageFilter(s)}>
              <span className={styles.d} style={{ background: m.color }} />{m.label} <span className={styles.n}>{counts[s]}</span>
            </button>
          );
        })}
      </div>

      {isLoading ? (
        <div className={styles.empty}>Загрузка…</div>
      ) : cards.length === 0 ? (
        <div className={styles.empty}>Нет заявок в этом фильтре.</div>
      ) : (
        <div className={styles.grid}>
          {cards.map(r => <RequestCard key={r.id} r={r} onOpen={() => setOpenId(r.id)} />)}
        </div>
      )}

      <div className={styles.legend}>
        Клик по карточке — рабочая панель: воронка кандидатов, ссылки HH, файлы, комментарии, переключатель этапа.
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

const RequestCard: FC<{ r: IHiringRequest; onOpen: () => void }> = ({ r, onOpen }) => {
  const m = stageMeta(r.stage);
  const isFunnel = FUNNEL_KEYS.includes(r.stage);
  const pct = m.idx ? Math.round((m.idx / 5) * 100) : (r.stage === 'rework' ? 8 : 0);
  const hcDone = r.headcount > 0 && r.approved_count >= r.headcount;
  const primary = r.assignees.find(a => a.is_primary) ?? r.assignees[0] ?? null;

  return (
    <button className={`${styles.card} ${r.is_urgent ? styles.cardUrgent : ''}`} onClick={onOpen}>
      <div className={styles.cardTop}>
        <div className={styles.cardPos}>{r.position_title}</div>
        <span className={`${styles.hc} ${hcDone ? styles.hcDone : ''}`}>
          {hcDone ? `✓ ${r.approved_count}/${r.headcount}` : `👤 ${r.headcount > 1 ? `${r.approved_count}/${r.headcount}` : r.headcount}`}
        </span>
      </div>
      <div className={styles.cust}>Заказчик: {r.customer_name || '—'}</div>

      <div className={styles.statRow}>
        {r.is_urgent && <span className={styles.urgentTag}>● Срочная</span>}
        {r.stage === 'rework'
          ? <span className={`${styles.stat} ${styles.statWarn}`}>⏱ ждёт заявителя</span>
          : r.stage === 'closed'
            ? <span className={styles.stat}>⏱ закрыта за {r.days_in_work} дн</span>
            : <span className={`${styles.stat} ${r.days_in_work > 14 ? styles.statWarn : ''}`}>⏱ {r.days_in_work} {pluralDays(r.days_in_work)} в работе</span>}
        {r.candidate_count > 0 && <span className={styles.stat}>👤 {r.candidate_count} канд.</span>}
      </div>

      {r.stage === 'rework' && r.rework_reason && (
        <div className={styles.reworkNote}>↩ Возвращена: {r.rework_reason.slice(0, 80)}{r.rework_reason.length > 80 ? '…' : ''}</div>
      )}

      <div className={styles.stageLine}>
        <span className={styles.stageName} style={{ color: m.color }}>{m.label}</span>
        <span className={styles.stagePct}>{isFunnel ? `этап ${m.idx}/5` : ''}</span>
      </div>
      <div className={styles.prog}><span style={{ width: `${pct}%`, background: m.color }} /></div>

      <div className={styles.cardFoot}>
        {primary
          ? <span className={styles.assignee}><Avatar name={primary.full_name} id={primary.employee_id} /> {primary.full_name}{r.assignees.length > 1 ? ` +${r.assignees.length - 1}` : ''}</span>
          : <span className={styles.assignee}><Avatar name={null} unassigned /> <span style={{ color: 'var(--text-tertiary)' }}>Не назначен</span></span>}
        <span className={styles.date}>{r.deadline ? `до ${fmtDate(r.deadline)}` : ''}</span>
      </div>
    </button>
  );
};
