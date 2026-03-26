import { useState, useCallback } from 'react';
import type { FC } from 'react';
import { RefreshCw, Trash2 } from 'lucide-react';
import { structureApi } from '../../api/structure';
import type {
  ISyncAllStep,
  IEmployeesProgressState,
  ISyncAllSummary,
  SyncStepName,
  SettingsTab,
  IUnmatchedSigurEmployee,
} from './sigur-settings.types';
import {
  STRUCTURE_SYNC_STEPS,
  DEFAULT_SYNC_ALL_STEPS,
  buildStepState,
  getSyncStepLabel,
  renderStepResult,
  readSseResponse,
  PHASE_LABELS,
} from './sigur-settings.utils';
import { SigurMatchModal } from './SigurMatchModal';

interface IStructureSyncSectionProps {
  connected: boolean | null;
  canEdit: boolean;
  organizationId: string | undefined;
  setError: (error: string) => void;
  setActiveTab: (tab: SettingsTab) => void;
  syncFilterSummary: string;
  externalBusy: boolean;
}

export const StructureSyncSection: FC<IStructureSyncSectionProps> = ({
  connected,
  canEdit,
  organizationId,
  setError,
  setActiveTab,
  syncFilterSummary,
  externalBusy,
}) => {
  const [syncAllRunning, setSyncAllRunning] = useState(false);
  const [selectedSyncAllSteps, setSelectedSyncAllSteps] = useState<SyncStepName[]>(DEFAULT_SYNC_ALL_STEPS);
  const [syncAllSteps, setSyncAllSteps] = useState<ISyncAllStep[]>(buildStepState(DEFAULT_SYNC_ALL_STEPS));
  const [syncAllDone, setSyncAllDone] = useState(false);
  const [syncAllSummary, setSyncAllSummary] = useState<ISyncAllSummary | null>(null);
  const [employeesProgress, setEmployeesProgress] = useState<IEmployeesProgressState | null>(null);

  const [unmatchedEmployees, setUnmatchedEmployees] = useState<IUnmatchedSigurEmployee[]>([]);
  const [showMatchModal, setShowMatchModal] = useState(false);

  const [clearingStructure, setClearingStructure] = useState(false);
  const [clearStructureResult, setClearStructureResult] = useState<{ employeesDeleted: number; departmentsDeleted: number } | null>(null);

  const busy = syncAllRunning || clearingStructure || externalBusy;

  const toggleSyncAllStep = (stepName: SyncStepName) => {
    if (busy) return;

    setSelectedSyncAllSteps(prev => {
      const hasStep = prev.includes(stepName);
      const next = STRUCTURE_SYNC_STEPS
        .map(step => step.name)
        .filter(name => (name === stepName ? !hasStep : prev.includes(name)));

      setSyncAllSteps(buildStepState(next));
      setSyncAllDone(false);
      return next;
    });
  };

  const handleSyncAll = useCallback(async () => {
    if (selectedSyncAllSteps.length === 0) {
      setError('Выберите хотя бы один шаг синхронизации');
      return;
    }

    setSyncAllRunning(true);
    setSyncAllDone(false);
    setSyncAllSummary(null);
    setEmployeesProgress(null);
    setError('');
    setSyncAllSteps(buildStepState(selectedSyncAllSteps));

    try {
      const token = localStorage.getItem('access_token');
      const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:3000/api';
      const response = await fetch(`${apiUrl}/sigur/sync-all`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ steps: selectedSyncAllSteps }),
      });
      await readSseResponse(response, data => {
        if (data.type === 'step' && typeof data.step === 'number') {
          setSyncAllSteps(prev => prev.map(step =>
            step.id === data.step
              ? {
                  ...step,
                  status: (data.status as ISyncAllStep['status']) || step.status,
                  result: (data.result as Record<string, unknown> | undefined) ?? step.result,
                  error: (data.error as string | undefined) ?? undefined,
                }
              : step,
          ));

          if (data.status === 'done' || data.status === 'error') {
            setEmployeesProgress(null);
          }
          return;
        }

        if (data.type === 'employees_progress') {
          setEmployeesProgress({
            percent: Number(data.percent || 0),
            current: Number(data.current || 0),
            total: Number(data.total || 0),
            phase: (data.phase as string) || undefined,
          });
          return;
        }

        if (data.type === 'done') {
          const failedSteps = Array.isArray(data.failedSteps)
            ? data.failedSteps.filter((step): step is SyncStepName =>
                typeof step === 'string' && STRUCTURE_SYNC_STEPS.some(candidate => candidate.name === step),
              )
            : [];

          // Извлекаем несопоставленных сотрудников
          const results = data.results as Record<string, Record<string, unknown>> | undefined;
          const empResult = results?.employees;
          const unmatchedArr = empResult?.unmatched as IUnmatchedSigurEmployee[] | undefined;
          if (unmatchedArr && unmatchedArr.length > 0) {
            setUnmatchedEmployees(unmatchedArr);
            setShowMatchModal(true);
          }

          setSyncAllSummary({
            hasErrors: Boolean(data.hasErrors),
            failedSteps,
            completedSteps: typeof data.completedSteps === 'number'
              ? data.completedSteps
              : Math.max(selectedSyncAllSteps.length - failedSteps.length, 0),
          });
          setSyncAllDone(true);
          setEmployeesProgress(null);
          return;
        }

        if (data.type === 'error') {
          setError(String(data.message || 'Ошибка синхронизации'));
        }
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка синхронизации');
    } finally {
      setSyncAllRunning(false);
      setEmployeesProgress(null);
    }
  }, [selectedSyncAllSteps, setError]);

  const handleClearStructure = async () => {
    if (!confirm('Удалить ВСЕ отделы и сотрудников организации? Это действие необратимо!')) return;
    setClearingStructure(true);
    setClearStructureResult(null);
    setError('');
    try {
      const result = await structureApi.clearStructure(organizationId);
      if (result.success && result.data) {
        setClearStructureResult(result.data);
      } else {
        setError(result.error || 'Ошибка очистки структуры');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка очистки структуры');
    } finally {
      setClearingStructure(false);
    }
  };

  return (
    <div className="sigur-section">
      <h2 className="sigur-section-title">
        <RefreshCw size={18} />
        Полная синхронизация структуры
      </h2>
      <div className="sigur-sync-summary">
        <span className="sigur-sync-summary-pill">{syncFilterSummary}</span>
        <button
          type="button"
          className="sigur-sync-summary-link"
          onClick={() => setActiveTab('sync-filter')}
        >
          Настроить фильтр
        </button>
      </div>
      <div className="sigur-sync-summary-note" style={{ marginBottom: '0.75rem' }}>
        Этот блок синхронизирует только структуру: отделы, должности и сотрудников. События загружаются отдельно ниже.
      </div>
      <div className="sigur-sync-steps-selector">
        {STRUCTURE_SYNC_STEPS.map(step => (
          <label key={step.name} className="sigur-sync-step-option">
            <input
              type="checkbox"
              checked={selectedSyncAllSteps.includes(step.name)}
              onChange={() => toggleSyncAllStep(step.name)}
              disabled={busy}
            />
            <span>{step.label}</span>
          </label>
        ))}
      </div>
      <div className="sigur-connection-row">
        <button
          className="sigur-btn sigur-btn-primary"
          onClick={handleSyncAll}
          disabled={busy || !connected || selectedSyncAllSteps.length === 0}
        >
          <RefreshCw size={14} className={syncAllRunning ? 'sigur-spin' : ''} />
          {syncAllRunning ? 'Синхронизация...' : 'Запустить выбранные шаги'}
        </button>
        {canEdit && (
          <button
            className="sigur-btn sigur-btn-danger"
            onClick={handleClearStructure}
            disabled={busy}
          >
            <Trash2 size={14} />
            {clearingStructure ? 'Очистка...' : 'Очистить структуру'}
          </button>
        )}
      </div>

      {clearStructureResult && (
        <div className="sigur-sync-result">
          <div className="sigur-sync-stats">
            <span className="sigur-sync-stat success">Удалено сотрудников: <strong>{clearStructureResult.employeesDeleted}</strong></span>
            <span className="sigur-sync-stat success">Удалено отделов: <strong>{clearStructureResult.departmentsDeleted}</strong></span>
          </div>
        </div>
      )}

      {syncAllSummary && (
        <div className="sigur-sync-result">
          <div className="sigur-sync-stats">
            <span className={`sigur-sync-stat ${syncAllSummary.hasErrors ? 'skipped' : 'success'}`}>
              {syncAllSummary.hasErrors ? 'Синхронизация структуры завершена с ошибками' : 'Синхронизация структуры завершена успешно'}
            </span>
            <span className="sigur-sync-stat">Выполнено: <strong>{syncAllSummary.completedSteps}/{syncAllSummary.completedSteps + syncAllSummary.failedSteps.length}</strong></span>
            {syncAllSummary.hasErrors && (
              <span className="sigur-sync-stat skipped">
                Шаги с ошибками: <strong>{syncAllSummary.failedSteps.map(getSyncStepLabel).join(', ')}</strong>
              </span>
            )}
          </div>
        </div>
      )}

      {(syncAllRunning || syncAllDone) && syncAllSteps.length > 0 && (
        <div className="sigur-stepper">
          {syncAllSteps.map(step => (
            <div key={step.id} className={`sigur-step sigur-step--${step.status}`}>
              <div className="sigur-step-indicator">
                {step.status === 'done' && <span>&#10003;</span>}
                {step.status === 'running' && <span className="sigur-step-spinner" />}
                {step.status === 'error' && <span>&#10007;</span>}
                {step.status === 'pending' && <span className="sigur-step-number">{step.id}</span>}
              </div>
              <div className="sigur-step-content">
                <div className="sigur-step-label">{step.label}</div>
                {step.status === 'running' && step.name === 'employees' && employeesProgress ? (
                  <div className="sigur-events-progress">
                    {employeesProgress.phase && (
                      <div className="sigur-step-phase">{PHASE_LABELS[employeesProgress.phase] || employeesProgress.phase}</div>
                    )}
                    <div className="sigur-events-progress-bar">
                      <div className="sigur-events-progress-fill" style={{ width: `${employeesProgress.percent}%` }} />
                    </div>
                    <span className="sigur-events-progress-text">
                      {employeesProgress.current}/{employeesProgress.total} — {employeesProgress.percent}%
                    </span>
                  </div>
                ) : step.status === 'running' && (
                  <div className="sigur-step-status">Выполняется...</div>
                )}
                {step.status === 'done' && step.result && (
                  <div className="sigur-step-result">
                    {renderStepResult(step.name, step.result)}
                    {(step.result.errors as string[] | undefined)?.length ? (
                      <details className="sigur-step-errors-detail">
                        <summary>Ошибки ({(step.result.errors as string[]).length})</summary>
                        <ul>
                          {(step.result.errors as string[]).slice(0, 20).map((e, i) => <li key={i}>{e}</li>)}
                          {(step.result.errors as string[]).length > 20 && <li>...и ещё {(step.result.errors as string[]).length - 20}</li>}
                        </ul>
                      </details>
                    ) : null}
                  </div>
                )}
                {step.status === 'error' && step.error && (
                  <div className="sigur-step-error">{step.error}</div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {showMatchModal && unmatchedEmployees.length > 0 && (
        <SigurMatchModal
          unmatched={unmatchedEmployees}
          onClose={() => setShowMatchModal(false)}
          onSaved={(result) => {
            setShowMatchModal(false);
            setUnmatchedEmployees([]);
            // Обновляем результат шага employees
            if (result.linked > 0 || result.created > 0) {
              setSyncAllSteps(prev => prev.map(step => {
                if (step.name !== 'employees' || !step.result) return step;
                return {
                  ...step,
                  result: {
                    ...step.result,
                    imported: ((step.result.imported as number) || 0) + result.created,
                    unmatched: [],
                  },
                };
              }));
            }
          }}
        />
      )}
    </div>
  );
};
