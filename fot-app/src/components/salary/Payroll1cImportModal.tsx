import { useId, useMemo, useRef, useState, type FC } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';

import { ApiError } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import {
  payroll1cPayoutsService,
  type IPayoutImportResult,
  type IPayoutPreview,
} from '../../services/payroll1cPayoutsService';
import {
  initialPayoutChoice,
  payoutChoicesPayload,
  payoutPreviewTotals,
  payoutRelinked,
  singleCandidateLines,
  type PayoutChoice,
} from '../../utils/payroll1cPayouts';
import { formatAccrualMonthLabel } from '../../utils/payrollAccruals';
import { formatPaidAmount } from '../../utils/payrollPaid';
import { ModalShell } from '../ui/ModalShell';
import { Payroll1cImportLines } from './Payroll1cImportLines';
import modal from './PayrollModal.module.css';
import styles from './Payroll1cImportModal.module.css';

interface IPayroll1cImportModalProps {
  onClose: () => void;
}

const STATUS_LABELS: Record<IPayoutPreview['status'], string> = {
  new: 'Новый документ',
  unchanged: 'Уже загружен, без изменений',
  enrich: 'Уже загружен — файл дополнит его',
  changed: 'Документ в 1С изменён',
};

const RESULT_LABELS: Record<IPayoutImportResult['action'], string> = {
  new: 'Ведомость загружена',
  enrich: 'Ведомость дополнена',
  relink: 'Сопоставление сохранено',
  replace: 'Ведомость заменена',
  unchanged: 'Изменений нет',
};

const formatDocDate = (date: string): string => date.split('-').reverse().join('.');
const errorText = (err: unknown, fallback: string): string => (err instanceof ApiError && err.message ? err.message : fallback);

/**
 * «Загрузить из 1С» на «Расчётах» (миграция 328): ведомость выплаты (XML ЗУП2 или внешней базы) → предпросмотр →
 * загрузка. Справочно: «Перечислено (1С)» в «Истории выплат», в расчётах ФОТ не участвует. Сотрудник строки —
 * автоматически только по коду физлица 1С; совпадения по ФИО оператор подтверждает. Повтор того же документа не
 * задваивает; изменённый в 1С — только явной заменой. Документ изменили, пока окно открыто, — «Проверить заново».
 */
export const Payroll1cImportModal: FC<IPayroll1cImportModalProps> = ({ onClose }) => {
  const titleId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<IPayoutPreview | null>(null);
  const [choices, setChoices] = useState<Map<string, PayoutChoice>>(new Map());
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; stale: boolean } | null>(null);

  const runPreview = async (target: File) => {
    setBusy(true);
    setError(null);
    try {
      const next = await payroll1cPayoutsService.preview(target);
      setPreview(next);
      setChoices(new Map(next.lines.map(line => [line.fingerprint, initialPayoutChoice(line)])));
      setConfirmReplace(false);
    } catch (err) {
      setPreview(null);
      setError({ text: errorText(err, 'Не удалось проверить файл'), stale: false });
    } finally {
      setBusy(false);
    }
  };

  const pickFile = (next: File | null) => {
    setFile(next);
    setPreview(null);
    setError(null);
    if (next) void runPreview(next);
  };

  const totals = useMemo(() => (preview ? payoutPreviewTotals(preview, choices) : null), [preview, choices]);
  const singles = useMemo(() => (preview ? singleCandidateLines(preview, choices) : []), [preview, choices]);
  const relinked = preview ? payoutRelinked(preview, choices) : false;
  const nothingToDo = preview?.status === 'unchanged' && !relinked;
  const canSubmit = !!preview && !!totals && !busy && totals.pendingLines === 0 && !nothingToDo
    && (preview.status !== 'changed' || confirmReplace);

  const submitLabel = (() => {
    if (!preview) return 'Загрузить';
    if (preview.status === 'changed') return 'Заменить';
    if (preview.status === 'new') return 'Загрузить';
    return relinked ? 'Сохранить сопоставление' : 'Дополнить';
  })();

  const submit = async (requestClose: () => void) => {
    if (!file || !preview || !canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const result = await payroll1cPayoutsService.importFile(file, {
        preview,
        confirmReplace,
        choices: payoutChoicesPayload(preview, choices),
      });
      await queryClient.invalidateQueries({ queryKey: ['payroll-terms'] });
      toast.success(`${RESULT_LABELS[result.action]}: с сотрудником ${result.lines_matched}, без сотрудника ${result.lines_unmatched}`);
      requestClose();
    } catch (err) {
      setError({ text: errorText(err, 'Не удалось загрузить ведомость'), stale: err instanceof ApiError && err.status === 409 });
    } finally {
      setBusy(false);
    }
  };

  const choose = (fingerprint: string, choice: PayoutChoice) => {
    setChoices(prev => new Map(prev).set(fingerprint, choice));
  };
  const confirmSingles = () => {
    setChoices(prev => {
      const next = new Map(prev);
      for (const line of singles) next.set(line.fingerprint, line.candidates[0].employee_id);
      return next;
    });
  };

  const doc = preview?.document;

  return (
    <ModalShell onClose={onClose} overlayClassName={modal.overlay} containerClassName={styles.container} aria-labelledby={titleId}>
      {({ requestClose }) => (
        <>
          <header className={modal.header}>
            <div className={modal.headerText}>
              <h2 id={titleId} className={modal.title}>Загрузить из 1С</h2>
              <p className={styles.subtitle}>
                Ведомость выплаты (XML ЗУП2 или внешней базы) — справочно, в «Историю выплат». На расчёты ФОТ не влияет.
              </p>
            </div>
            <button type="button" className={modal.closeButton} onClick={requestClose} aria-label="Закрыть">
              <X size={20} aria-hidden="true" />
            </button>
          </header>

          <div className={modal.body}>
            <div className={styles.fileRow}>
              <input
                ref={fileInputRef}
                type="file"
                accept=".xml,text/xml,application/xml"
                className={styles.srOnly}
                onChange={event => { pickFile(event.target.files?.[0] ?? null); event.target.value = ''; }}
              />
              <button type="button" className={styles.button} disabled={busy} onClick={() => fileInputRef.current?.click()}>
                {file ? 'Другой файл' : 'Выбрать файл .xml'}
              </button>
              {file && <span className={styles.fileName}>{file.name}</span>}
              {busy && <span className={styles.muted}>Проверка…</span>}
            </div>

            {error && (
              <div className={styles.error} role="alert">
                <span>{error.text}</span>
                {error.stale && file && (
                  <button type="button" className={styles.button} disabled={busy} onClick={() => { void runPreview(file); }}>
                    Проверить заново
                  </button>
                )}
              </div>
            )}

            {preview && doc && totals && (
              <>
                <dl className={styles.facts}>
                  <div><dt>Ведомость</dt><dd>№ {doc.doc_number}{doc.zup2_number ? ` (ЗУП2 № ${doc.zup2_number})` : ''} от {formatDocDate(doc.doc_date)}</dd></div>
                  <div><dt>Месяц начисления</dt><dd>{formatAccrualMonthLabel(doc.period_month.slice(0, 7), true)}</dd></div>
                  <div><dt>Способ выплаты</dt><dd>{doc.payment_method}</dd></div>
                  <div><dt>Сумма</dt><dd>{formatPaidAmount(Number(doc.total_amount))}</dd></div>
                  <div><dt>Статус</dt><dd className={styles.status} data-status={preview.status}>{STATUS_LABELS[preview.status]}</dd></div>
                </dl>

                {preview.status === 'enrich' && preview.enrich_fields.length > 0 && (
                  <p className={styles.muted}>Дополнит: {preview.enrich_fields.join(', ')}.</p>
                )}
                {preview.status === 'changed' && preview.changes && (
                  <div className={styles.changes}>
                    <ul>
                      {preview.changes.header.map(change => (
                        <li key={change.field}>{change.field}: {change.before ?? '—'} → {change.after ?? '—'}</li>
                      ))}
                      {preview.changes.removed.map(item => <li key={`r-${item}`}>Было: {item}</li>)}
                      {preview.changes.added.map(item => <li key={`a-${item}`}>Стало: {item}</li>)}
                    </ul>
                    <label className={styles.checkbox}>
                      <input type="checkbox" checked={confirmReplace} onChange={event => setConfirmReplace(event.target.checked)} />
                      Заменить сохранённый документ (прежний останется в журнале)
                    </label>
                  </div>
                )}

                {singles.length > 0 && (
                  <button type="button" className={styles.button} disabled={busy} onClick={confirmSingles}>
                    Подтвердить совпадения по ФИО ({singles.length})
                  </button>
                )}

                <Payroll1cImportLines lines={preview.lines} choices={choices} onChoose={choose} disabled={busy} />

                <p className={styles.totals}>
                  С сотрудником: {formatPaidAmount(totals.matched)} · без сотрудника: {formatPaidAmount(totals.unmatched)}
                  {totals.pendingLines > 0 && ` · не выбрано: ${totals.pendingLines} (${formatPaidAmount(totals.pending)})`}
                </p>
              </>
            )}
          </div>

          <footer className={styles.footer}>
            <button type="button" className={styles.button} onClick={requestClose}>
              {nothingToDo ? 'Закрыть' : 'Отмена'}
            </button>
            {!nothingToDo && (
              <button type="button" className={styles.primaryButton} disabled={!canSubmit} onClick={() => { void submit(requestClose); }}>
                {submitLabel}
              </button>
            )}
          </footer>
        </>
      )}
    </ModalShell>
  );
};
