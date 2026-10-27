import { useRef, useState, type FC, type KeyboardEvent } from 'react';

import type { ITimesheetSalaryResponse, TimesheetSalaryErrorCode } from '../../types/timesheet';
import { formatMoneyInput, parseMoneyInput, toMoneyInput } from '../../utils/moneyInput';
import { formatTimesheetEmployeeName } from '../../utils/timesheetDisplay';
import { ClearableInput } from '../ui/ClearableInput';
import type { ITimesheetSalaryGridProps } from './TimesheetSalaryCells';

const ERROR_LABELS: Record<TimesheetSalaryErrorCode, string> = {
  no_schedule: 'нет графика',
  unknown_status: 'неизвестный статус дня',
  duplicate_day: 'день в двух подачах',
};

const formatDayMonth = (iso: string): string => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;

/** Пометка состояния сумм бригады: «Предварительно, по 26.10», «По закрытому табелю 03.11» и т.п. */
const describeState = (data: ITimesheetSalaryResponse): { text: string; tone: 'muted' | 'ok' | 'warn' | 'error'; title?: string } | null => {
  if (data.distribution === 'error' && data.errors.length > 0) {
    const first = data.errors[0];
    const more = data.errors.length > 1 ? ` (ещё ${data.errors.length - 1})` : '';
    return {
      text: `Ошибка: ${ERROR_LABELS[first.code]} — ${formatTimesheetEmployeeName(first.full_name)}${more}`,
      tone: 'error',
      title: data.errors
        .map(error => `${formatTimesheetEmployeeName(error.full_name)}, ${formatDayMonth(error.date)}: ${ERROR_LABELS[error.code]}`)
        .join('\n'),
    };
  }
  if (data.state === 'stale') return { text: 'Требует перерасчёта — табель открыт', tone: 'warn' };
  if (data.distribution === 'nothing_to_distribute') {
    return { text: 'Нет учтённых часов — выработку не распределить', tone: 'warn' };
  }
  if (data.state === 'fixed') {
    return { text: `По закрытому табелю${data.computed_at ? ` ${formatDayMonth(data.computed_at.slice(0, 10))}` : ''}`, tone: 'ok' };
  }
  if (data.state === 'preliminary') {
    return { text: `Предварительно${data.as_of ? `, по ${formatDayMonth(data.as_of)}` : ''}`, tone: 'muted' };
  }
  return null;
};

interface ITimesheetSalaryHeaderProps {
  salary: ITimesheetSalaryGridProps;
}

/** «Выработка, ₽» бригады и пометка состояния — в строке-заголовке бригады. */
export const TimesheetSalaryHeader: FC<ITimesheetSalaryHeaderProps> = ({ salary }) => {
  const { data } = salary;
  const savedValue = toMoneyInput(data?.output_amount ?? null);
  // Черновик живёт, пока поле в фокусе; вне фокуса — сохранённое (смена месяца, ответ сервера).
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? savedValue;
  // Escape — выйти без сохранения: blur приходит в том же обработчике, до перерисовки.
  const cancelRef = useRef(false);

  if (!data || data.kind !== 'brigade') return null;
  const state = describeState(data);

  const commit = async (): Promise<void> => {
    const parsed = parseMoneyInput(value);
    const next = parsed === null ? null : Number(parsed);
    const current = data.output_amount === null ? null : Number(data.output_amount);
    if (cancelRef.current || (next !== null && !Number.isFinite(next)) || next === current) {
      cancelRef.current = false;
      setDraft(null);
      return;
    }
    try {
      // Черновик держим до ответа: иначе поле на миг покажет прежнюю сумму.
      await salary.onOutputSave(next);
    } catch {
      // Тост об ошибке показал хук; в поле вернётся сохранённое значение.
    } finally {
      setDraft(null);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') event.currentTarget.blur();
    if (event.key === 'Escape') {
      cancelRef.current = true;
      event.currentTarget.blur();
    }
  };

  return (
    <div className="ts-salary-header">
      <label className="ts-salary-output">
        <span className="ts-salary-output-label">Выработка, ₽</span>
        {salary.canEdit ? (
          <ClearableInput
            className="ts-salary-output-input"
            value={value}
            onValueChange={next => setDraft(formatMoneyInput(next))}
            // Крестик у поля без фокуса сначала очищает, потом ставит фокус — очищенное не затираем.
            onFocus={() => setDraft(current => current ?? savedValue)}
            onBlur={() => { void commit(); }}
            onKeyDown={handleKeyDown}
            inputMode="decimal"
            autoComplete="off"
            disabled={salary.savingOutput}
            clearLabel="Очистить выработку"
          />
        ) : (
          <span className="ts-salary-output-value">{savedValue || '—'}</span>
        )}
      </label>
      {state && (
        <span className={`ts-salary-state ts-salary-state--${state.tone}`} title={state.title}>
          {state.text}
        </span>
      )}
    </div>
  );
};
