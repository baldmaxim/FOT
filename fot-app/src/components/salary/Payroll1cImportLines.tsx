import type { FC } from 'react';

import type { IPayoutCandidate, IPayoutPreviewLine } from '../../services/payroll1cPayoutsService';
import type { PayoutChoice } from '../../utils/payroll1cPayouts';
import { formatPaidAmount } from '../../utils/payrollPaid';
import styles from './Payroll1cImportModal.module.css';

interface IPayroll1cImportLinesProps {
  lines: readonly IPayoutPreviewLine[];
  choices: ReadonlyMap<string, PayoutChoice>;
  onChoose: (fingerprint: string, choice: PayoutChoice) => void;
  disabled: boolean;
}

const NONE = 'none';
const UNSET = '';

const candidateLabel = (candidate: IPayoutCandidate, autoId: number | null): string => {
  const notes = [
    candidate.employee_id === autoId ? 'по коду 1С' : null,
    candidate.brigade_match ? 'бригада совпала' : null,
    candidate.worked_in_month ? null : 'не работал в этом месяце',
  ].filter(Boolean);
  const base = candidate.department ? `${candidate.full_name} · ${candidate.department}` : candidate.full_name;
  return notes.length > 0 ? `${base} (${notes.join(', ')})` : base;
};

/**
 * Строки ведомости в окне загрузки: ФИО и бригада из 1С, сумма и сотрудник ФОТ. Автоматически — только по коду
 * физлица 1С; по ФИО — кандидаты, которых оператор выбирает сам (или «Без сотрудника»). Сохранённый сотрудник,
 * которого уже нет среди кандидатов, остаётся в списке, чтобы выбор не потерялся.
 */
export const Payroll1cImportLines: FC<IPayroll1cImportLinesProps> = ({ lines, choices, onChoose, disabled }) => (
  <div className={styles.linesScroll}>
    <table className={styles.lines}>
      <thead>
        <tr>
          <th scope="col" className={styles.lineNo}>№</th>
          <th scope="col">ФИО из 1С</th>
          <th scope="col" className={styles.num}>Сумма</th>
          <th scope="col">Сотрудник ФОТ</th>
        </tr>
      </thead>
      <tbody>
        {lines.map(line => {
          const choice = choices.get(line.fingerprint);
          const value = choice === undefined ? UNSET : choice === null ? NONE : String(choice);
          const keepsStored = line.current_employee_id !== null
            && !line.candidates.some(candidate => candidate.employee_id === line.current_employee_id);
          const selectId = `payout-line-${line.fingerprint}`;
          return (
            <tr key={line.fingerprint} className={choice === undefined ? styles.linePending : undefined}>
              <td className={styles.lineNo}>{line.line_no}</td>
              <td>
                <span className={styles.lineName}>{line.full_name}</span>
                {line.brigade && <span className={styles.lineNote}>{line.brigade}</span>}
              </td>
              <td className={styles.num}>{formatPaidAmount(Number(line.amount))}</td>
              <td className={styles.choiceCell}>
                <label htmlFor={selectId} className={styles.srOnly}>Сотрудник ФОТ для строки {line.line_no}</label>
                <select
                  id={selectId}
                  className={styles.select}
                  value={value}
                  disabled={disabled}
                  onChange={event => {
                    const next = event.target.value;
                    onChoose(line.fingerprint, next === UNSET ? undefined : next === NONE ? null : Number(next));
                  }}
                >
                  {choice === undefined && (
                    <option value={UNSET}>{line.candidates.length > 0 ? 'Выберите сотрудника' : 'Нет в ФОТ'}</option>
                  )}
                  {keepsStored && (
                    <option value={String(line.current_employee_id)}>Сохранённый сотрудник (id {line.current_employee_id})</option>
                  )}
                  {line.candidates.map(candidate => (
                    <option key={candidate.employee_id} value={String(candidate.employee_id)}>
                      {candidateLabel(candidate, line.auto_employee_id)}
                    </option>
                  ))}
                  <option value={NONE}>Без сотрудника</option>
                </select>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  </div>
);
