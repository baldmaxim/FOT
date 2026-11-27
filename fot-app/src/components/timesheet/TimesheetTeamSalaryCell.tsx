import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FC, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

import { ModalShell } from '../ui/ModalShell';
import type { ITeamSalaryResponse, TeamSalaryRow } from '../../services/teamSalaryService';
import {
  teamSalaryCellText,
  teamSalaryColumnTitle,
  teamSalaryHeader,
  teamSalaryMonthName,
  teamSalaryReasonText,
} from '../../utils/teamSalary';
import { TeamSalaryBreakdown } from './TeamSalaryBreakdown';
import styles from './TimesheetTeamSalary.module.css';

/** Столбец «Зарплата» руководителя (миграция 382) — данные для сетки. */
export interface ITimesheetTeamSalaryGridProps {
  data: ITeamSalaryResponse | undefined;
  rows: ReadonlyMap<number, TeamSalaryRow>;
  loading: boolean;
  failed: boolean;
}

interface ICellProps {
  teamSalary: ITimesheetTeamSalaryGridProps;
  employeeId: number;
  employeeName: string;
}

const POPOVER_GAP = 8;
/** Метка поповера: прокрутка внутри него — не повод закрываться. */
const POPOVER_ATTR = 'data-team-salary-popover';
const POPOVER_MARGIN = 8;
const HIDE_DELAY_MS = 150;

/** Наведение есть — десктоп; иначе по нажатию окно (тач-экраны). */
const canHover = (): boolean => (
  typeof window !== 'undefined' && window.matchMedia('(hover: hover) and (pointer: fine)').matches
);

interface IPopoverProps {
  anchor: HTMLElement;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  children: ReactNode;
}

/** Поповер у ячейки через портал: таблица прокручивается и обрезала бы его. Слева от ячейки, в пределах экрана. */
const TeamSalaryPopover: FC<IPopoverProps> = ({ anchor, onPointerEnter, onPointerLeave, children }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const popover = ref.current;
    if (!popover) return;
    const rect = anchor.getBoundingClientRect();
    const width = popover.offsetWidth;
    const height = popover.offsetHeight;
    let left = rect.left - width - POPOVER_GAP;
    if (left < POPOVER_MARGIN) left = Math.max(POPOVER_MARGIN, Math.min(rect.right - width, window.innerWidth - width - POPOVER_MARGIN));
    const top = Math.max(POPOVER_MARGIN, Math.min(rect.top, window.innerHeight - height - POPOVER_MARGIN));
    setPosition({ top, left });
  }, [anchor]);

  return createPortal(
    <div
      ref={ref}
      className={styles.popover}
      data-team-salary-popover=""
      role="tooltip"
      // Позиция считается по ячейке после замера — динамическое значение.
      style={position ? { top: position.top, left: position.left } : { visibility: 'hidden', top: 0, left: 0 }}
      onMouseEnter={onPointerEnter}
      onMouseLeave={onPointerLeave}
    >
      {children}
    </div>,
    document.body,
  );
};

interface IModalProps {
  month: string;
  employeeName: string;
  row: TeamSalaryRow;
  onClose: () => void;
}

/** Расшифровка в окне — на тач-экранах и в мобильной карточке. */
export const TeamSalaryModal: FC<IModalProps> = ({ month, employeeName, row, onClose }) => (
  <ModalShell
    onClose={onClose}
    overlayClassName={styles.overlay}
    containerClassName={styles.modal}
    aria-label={`Зарплата за ${teamSalaryMonthName(month)}`}
  >
    {({ requestClose }) => (
      <>
        <div className={styles.modalHeader}>
          <span className={styles.modalTitle}>Зарплата за {teamSalaryMonthName(month)}</span>
          <button type="button" className={styles.modalClose} onClick={requestClose} aria-label="Закрыть">
            <X size={18} />
          </button>
        </div>
        <div className={styles.modalBody}>
          {row.status === 'ready'
            ? <TeamSalaryBreakdown month={month} employeeName={employeeName} calc={row.calc} />
            : <p className={styles.reason}>{teamSalaryReasonText(row, month)}</p>}
        </div>
      </>
    )}
  </ModalShell>
);

/** Ячейка «Зарплата» десктопной сетки: сумма; наведение — «Расчёт ФОТ», у «—» — причина подсказкой. */
export const TimesheetTeamSalaryCell: FC<ICellProps> = ({ teamSalary, employeeId, employeeName }) => {
  const { data, rows, loading, failed } = teamSalary;
  const row = rows.get(employeeId);
  const ready = row?.status === 'ready' && data ? row : null;
  // Якорь поповера — в состоянии (callback-ref): читать ref во время рендера нельзя.
  const [anchorEl, setAnchorEl] = useState<HTMLButtonElement | null>(null);
  const hideTimer = useRef<number | undefined>(undefined);
  // Курсор над суммой или над поповером: уход фокуса (клик по тексту поповера) тогда не закрывает его.
  const pointerOver = useRef({ anchor: false, popover: false });
  // Открыто для конкретной строки ответа: новый ответ (смена месяца, снятие доступа, обновление) — новые объекты строк,
  // и расшифровка закрывается сама, не всплывая заново без наведения.
  const [popoverFor, setPopoverFor] = useState<TeamSalaryRow | null>(null);
  const [modalFor, setModalFor] = useState<TeamSalaryRow | null>(null);
  const popoverOpen = ready !== null && popoverFor === ready;
  const modalOpen = ready !== null && modalFor === ready;

  const show = useCallback(() => {
    window.clearTimeout(hideTimer.current);
    setPopoverFor(ready);
  }, [ready]);
  const hide = useCallback(() => {
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      if (!pointerOver.current.anchor && !pointerOver.current.popover) setPopoverFor(null);
    }, HIDE_DELAY_MS);
  }, []);

  useEffect(() => () => window.clearTimeout(hideTimer.current), []);

  // Поповер закрыт (прокрутка, смена размера, новые данные) — курсор над ним больше не считается.
  useEffect(() => {
    if (!popoverOpen) pointerOver.current.popover = false;
  }, [popoverOpen]);

  // Прокрутка таблицы уводит ячейку — поповер закрывается, а не висит над чужой строкой. Прокрутка длинной
  // расшифровки внутри самого поповера его не закрывает.
  useEffect(() => {
    if (!popoverOpen) return undefined;
    const closeOnScroll = (event: Event): void => {
      if (event.target instanceof Element && event.target.closest(`[${POPOVER_ATTR}]`)) return;
      setPopoverFor(null);
    };
    const closeOnResize = (): void => setPopoverFor(null);
    window.addEventListener('scroll', closeOnScroll, true);
    window.addEventListener('resize', closeOnResize);
    return () => {
      window.removeEventListener('scroll', closeOnScroll, true);
      window.removeEventListener('resize', closeOnResize);
    };
  }, [popoverOpen]);

  if (loading) return <td className="ts-col-team-salary-sticky ts-team-salary--muted">…</td>;
  if (failed) {
    return <td className="ts-col-team-salary-sticky ts-team-salary--muted" title="Не удалось загрузить зарплату">—</td>;
  }
  if (!data || !row) return <td className="ts-col-team-salary-sticky" />;
  if (!ready) {
    return (
      <td className="ts-col-team-salary-sticky ts-team-salary--muted" title={teamSalaryReasonText(row, data.month) ?? undefined}>
        —
      </td>
    );
  }

  return (
    <td className="ts-col-team-salary-sticky">
      <button
        ref={setAnchorEl}
        type="button"
        className={styles.amountButton}
        aria-label={`Зарплата за ${teamSalaryMonthName(data.month)}: ${teamSalaryCellText(ready)} — расшифровка`}
        aria-expanded={popoverOpen || modalOpen}
        onMouseEnter={() => {
          pointerOver.current.anchor = true;
          if (canHover()) show();
        }}
        onMouseLeave={() => {
          pointerOver.current.anchor = false;
          hide();
        }}
        onFocus={() => { if (canHover()) show(); }}
        onBlur={hide}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            pointerOver.current = { anchor: false, popover: false };
            setPopoverFor(null);
          }
        }}
        onClick={() => {
          if (canHover()) show();
          else setModalFor(ready);
        }}
      >
        {teamSalaryCellText(ready)}
      </button>
      {popoverOpen && anchorEl && (
        <TeamSalaryPopover
          anchor={anchorEl}
          onPointerEnter={() => {
            pointerOver.current.popover = true;
            show();
          }}
          onPointerLeave={() => {
            pointerOver.current.popover = false;
            hide();
          }}
        >
          <TeamSalaryBreakdown month={data.month} employeeName={employeeName} calc={ready.calc} />
        </TeamSalaryPopover>
      )}
      {modalOpen && (
        <TeamSalaryModal month={data.month} employeeName={employeeName} row={ready} onClose={() => setModalFor(null)} />
      )}
    </td>
  );
};

/** Шапка столбца: «Зарплата · окт.» с подсказкой о месяце и дате следующего. */
export const TimesheetTeamSalaryHeader: FC<{ teamSalary: ITimesheetTeamSalaryGridProps }> = ({ teamSalary }) => {
  const { data } = teamSalary;
  return (
    <th
      className="ts-col-team-salary-sticky"
      title={data ? teamSalaryColumnTitle(data) : 'Зарплата за прошлый месяц — к выплате, без НДФЛ'}
    >
      {data ? teamSalaryHeader(data.month) : 'Зарплата'}
    </th>
  );
};

/** Мобильная карточка: строка «Зарплата · окт.: 139 942,00» под ФИО; нажатие — окно с расшифровкой. */
export const TimesheetTeamSalaryMobileRow: FC<ICellProps> = ({ teamSalary, employeeId, employeeName }) => {
  const { data, rows, loading, failed } = teamSalary;
  const row = rows.get(employeeId);
  const ready = row?.status === 'ready' && data ? row : null;
  const [modalFor, setModalFor] = useState<TeamSalaryRow | null>(null);
  const modalOpen = ready !== null && modalFor === ready;

  if (loading) return <div className="ts-team-salary-mobile-row ts-team-salary--muted">Зарплата: …</div>;
  if (failed) return <div className="ts-team-salary-mobile-row ts-team-salary--muted">Зарплата: не удалось загрузить</div>;
  if (!data || !row) return null;
  const label = `${teamSalaryHeader(data.month)}:`;
  if (!ready) {
    return (
      <div className="ts-team-salary-mobile-row">
        <span className="ts-team-salary-mobile-label">{label}</span>
        <span className="ts-team-salary--muted">— {teamSalaryReasonText(row, data.month)}</span>
      </div>
    );
  }
  return (
    <div className="ts-team-salary-mobile-row">
      <span className="ts-team-salary-mobile-label">{label}</span>
      <button
        type="button"
        className={styles.mobileAmountButton}
        onClick={() => setModalFor(ready)}
        aria-label={`Зарплата за ${teamSalaryMonthName(data.month)}: ${teamSalaryCellText(ready)} — расшифровка`}
      >
        {teamSalaryCellText(ready)}
      </button>
      {modalOpen && (
        <TeamSalaryModal month={data.month} employeeName={employeeName} row={ready} onClose={() => setModalFor(null)} />
      )}
    </div>
  );
};
