import { useMemo, useState, type FC } from 'react';
import { Copy } from 'lucide-react';
import { useSkudMonitorLogs } from '../../hooks/useSkudOpsData';
import { useToast } from '../../contexts/ToastContext';
import { copyTextToClipboard } from '../../utils/clipboard';

const formatJson = (value: unknown): string => JSON.stringify(value, null, 2);

export const SigurDiagnosticsButton: FC = () => {
  const [copying, setCopying] = useState(false);
  const toast = useToast();
  const logsQuery = useSkudMonitorLogs('all');

  const logs = logsQuery.data?.data ?? [];
  const logsTotal = logsQuery.data?.pagination.total ?? logs.length;

  const problemsCount = useMemo(
    () => logs.filter(log => log.status === 'failure' || log.status === 'silence').length,
    [logs],
  );

  const diagnosticJson = useMemo(() => formatJson({
    exportedAt: new Date().toISOString(),
    page: 'skud-settings',
    filter: 'all',
    logsTotal,
    problemsCount,
    logs,
  }), [logs, logsTotal, problemsCount]);

  const handleCopy = async () => {
    try {
      setCopying(true);
      await copyTextToClipboard(diagnosticJson);
      toast.success('JSON логов скопирован');
    } catch {
      toast.error('Не удалось скопировать JSON логов');
    } finally {
      setCopying(false);
    }
  };

  const label = problemsCount > 0
    ? `Копировать JSON (${problemsCount})`
    : 'Копировать JSON';

  return (
    <button
      type="button"
      className="sigur-btn"
      onClick={() => void handleCopy()}
      disabled={copying || logsQuery.isLoading}
      title={problemsCount > 0 ? `Проблем в логах: ${problemsCount}` : 'Диагностика без ошибок'}
    >
      <Copy size={14} />
      {copying ? 'Копируем...' : label}
    </button>
  );
};
