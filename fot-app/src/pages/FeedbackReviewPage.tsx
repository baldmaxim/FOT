import { type FC, lazy, Suspense, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Settings } from 'lucide-react';
import { feedbackService, type FeedbackKind, type IDepartmentStat } from '../services/feedbackService';
import { testsService } from '../services/testsService';
import styles from './FeedbackReviewPage.module.css';

const TestManagementModal = lazy(() =>
  import('../components/tests/TestManagementModal').then(m => ({ default: m.TestManagementModal })),
);

type SubTab = 'tasks' | 'suggestions' | 'complaints' | 'tests';

const SUB_TABS: Array<{ key: SubTab; label: string }> = [
  { key: 'tasks', label: 'Задачи' },
  { key: 'suggestions', label: 'Предложения' },
  { key: 'complaints', label: 'Жалобы' },
  { key: 'tests', label: 'Тесты' },
];

const fmtDate = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

const fmtDay = (d: string): string => new Date(d).toLocaleDateString('ru-RU');

// Панель статистики по отделам.
const StatsPanel: FC<{ stats: IDepartmentStat[]; verb: string }> = ({ stats, verb }) => {
  if (!stats.length) return null;
  return (
    <div className={styles.stats}>
      {stats.map(s => (
        <div key={s.department_id ?? s.department_name} className={styles.statItem}>
          <span className={styles.statDept}>{s.department_name}</span>
          <span className={styles.statValue}>{s.filled}/{s.total} {verb}</span>
        </div>
      ))}
    </div>
  );
};

interface IFilterBarProps {
  q: string; onQ: (v: string) => void;
  from: string; onFrom: (v: string) => void;
  to: string; onTo: (v: string) => void;
  departments?: Array<{ id: string | null; name: string }>;
  department?: string; onDepartment?: (v: string) => void;
}

const FilterBar: FC<IFilterBarProps> = ({ q, onQ, from, onFrom, to, onTo, departments, department, onDepartment }) => (
  <div className={styles.filters}>
    <input className={styles.search} placeholder="Поиск по ФИО" value={q} onChange={e => onQ(e.target.value)} />
    {departments && onDepartment && (
      <select className={styles.select} value={department ?? ''} onChange={e => onDepartment(e.target.value)}>
        <option value="">Все отделы</option>
        {departments.filter(d => d.id).map(d => (
          <option key={d.id} value={d.id as string}>{d.name}</option>
        ))}
      </select>
    )}
    <input className={styles.date} type="date" value={from} onChange={e => onFrom(e.target.value)} />
    <input className={styles.date} type="date" value={to} onChange={e => onTo(e.target.value)} />
  </div>
);

// ---- Вкладка «Задачи» ----
const TasksTab: FC = () => {
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [department, setDepartment] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['fb-tasks', q, from, to, department],
    queryFn: () => feedbackService.listTasks({ q, from, to, department }),
    staleTime: 30_000,
  });

  const departments = useMemo(
    () => (data?.stats ?? []).map(s => ({ id: s.department_id, name: s.department_name })),
    [data],
  );

  return (
    <div className={styles.tabBody}>
      <FilterBar q={q} onQ={setQ} from={from} onFrom={setFrom} to={to} onTo={setTo}
        departments={departments} department={department} onDepartment={setDepartment} />
      <StatsPanel stats={data?.stats ?? []} verb="заполнили" />
      {isLoading ? <div className={styles.empty}>Загрузка…</div> : (
        <table className={styles.table}>
          <thead><tr><th>Сотрудник</th><th>Отдел</th><th>Задача</th><th>Дата</th></tr></thead>
          <tbody>
            {(data?.rows ?? []).map(r => (
              <tr key={r.id}>
                <td>{r.full_name ?? '—'}</td>
                <td>{r.department_name ?? '—'}</td>
                <td className={styles.textCell}>{r.content}</td>
                <td>{fmtDay(r.task_date)}</td>
              </tr>
            ))}
            {!data?.rows.length && <tr><td colSpan={4} className={styles.empty}>Нет данных</td></tr>}
          </tbody>
        </table>
      )}
    </div>
  );
};

// ---- Вкладки «Предложения» / «Жалобы» ----
const MessagesTab: FC<{ kind: FeedbackKind }> = ({ kind }) => {
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['fb-messages', kind, q, from, to],
    queryFn: () => feedbackService.listMessages(kind, { q, from, to }),
    staleTime: 30_000,
  });

  return (
    <div className={styles.tabBody}>
      <FilterBar q={q} onQ={setQ} from={from} onFrom={setFrom} to={to} onTo={setTo} />
      {isLoading ? <div className={styles.empty}>Загрузка…</div> : (
        <table className={styles.table}>
          <thead><tr><th>Автор</th><th>Сообщение</th><th>Время</th></tr></thead>
          <tbody>
            {(data ?? []).map(r => (
              <tr key={r.id}>
                <td>{r.is_anonymous ? <em className={styles.anon}>Анонимно</em> : r.author}</td>
                <td className={styles.textCell}>{r.content}</td>
                <td>{fmtDate(r.created_at)}</td>
              </tr>
            ))}
            {!data?.length && <tr><td colSpan={3} className={styles.empty}>Нет данных</td></tr>}
          </tbody>
        </table>
      )}
    </div>
  );
};

// ---- Вкладка «Тесты» ----
const TestsTab: FC = () => {
  const [selectedTest, setSelectedTest] = useState<string>('');
  const [q, setQ] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [department, setDepartment] = useState('');
  const [managerOpen, setManagerOpen] = useState(false);

  const { data: tests } = useQuery({
    queryKey: ['tests-manage-list'],
    queryFn: () => testsService.list(),
    staleTime: 30_000,
  });

  const effectiveTest = selectedTest || tests?.[0]?.id || '';

  const { data: stats } = useQuery({
    queryKey: ['test-stats', effectiveTest],
    queryFn: () => testsService.getStats(effectiveTest),
    enabled: !!effectiveTest,
    staleTime: 30_000,
  });

  const { data: responses } = useQuery({
    queryKey: ['test-responses', effectiveTest],
    queryFn: () => testsService.listResponses(effectiveTest),
    enabled: !!effectiveTest,
    staleTime: 30_000,
  });

  const departments = useMemo(
    () => (stats ?? []).map(s => ({ id: s.department_id, name: s.department_name })),
    [stats],
  );

  const filtered = useMemo(() => (responses ?? []).filter(r => {
    if (r.status !== 'submitted') return false;
    if (q && !(r.full_name ?? '').toLowerCase().includes(q.toLowerCase())) return false;
    if (department && r.department_name !== (departments.find(d => d.id === department)?.name)) return false;
    if (from && (!r.submitted_at || r.submitted_at < from)) return false;
    if (to && (!r.submitted_at || r.submitted_at > `${to}T23:59:59`)) return false;
    return true;
  }), [responses, q, department, from, to, departments]);

  return (
    <div className={styles.tabBody}>
      <div className={styles.testsHead}>
        <select className={styles.select} value={effectiveTest} onChange={e => setSelectedTest(e.target.value)}>
          {(tests ?? []).map(t => (
            <option key={t.id} value={t.id}>{t.title}{t.is_active ? '' : ' (неактивен)'}</option>
          ))}
          {!tests?.length && <option value="">Тестов нет</option>}
        </select>
        <button className={styles.gearBtn} onClick={() => setManagerOpen(true)} title="Управление тестами">
          <Settings size={18} />
        </button>
      </div>

      <FilterBar q={q} onQ={setQ} from={from} onFrom={setFrom} to={to} onTo={setTo}
        departments={departments} department={department} onDepartment={setDepartment} />
      <StatsPanel stats={stats ?? []} verb="прошли" />

      <table className={styles.table}>
        <thead><tr><th>Сотрудник</th><th>Отдел</th><th>Статус</th><th>Время</th></tr></thead>
        <tbody>
          {filtered.map(r => (
            <tr key={r.id}>
              <td>{r.full_name ?? '—'}</td>
              <td>{r.department_name ?? '—'}</td>
              <td>Пройден</td>
              <td>{fmtDate(r.submitted_at)}</td>
            </tr>
          ))}
          {!filtered.length && <tr><td colSpan={4} className={styles.empty}>Нет прохождений</td></tr>}
        </tbody>
      </table>

      {managerOpen && (
        <Suspense fallback={null}>
          <TestManagementModal onClose={() => setManagerOpen(false)} />
        </Suspense>
      )}
    </div>
  );
};

export const FeedbackReviewPage: FC = () => {
  const [tab, setTab] = useState<SubTab>('tasks');

  return (
    <div className={styles.page}>
      <div className={styles.subTabs}>
        {SUB_TABS.map(t => (
          <button
            key={t.key}
            className={`${styles.subTab} ${tab === t.key ? styles.subTabActive : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'tasks' && <TasksTab />}
      {tab === 'suggestions' && <MessagesTab kind="suggestion" />}
      {tab === 'complaints' && <MessagesTab kind="complaint" />}
      {tab === 'tests' && <TestsTab />}
    </div>
  );
};
