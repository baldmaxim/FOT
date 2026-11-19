/**
 * Сверка списка общежитий из 1С (xlsx «Список проживающих в общ. на <дата>») с открытыми проживаниями «Общежития»
 * портала (класс dormitory: вид dormitory без служебной квартиры) — чистая функция для генератора
 * scripts/build-dormitory-sync-sql.ts и его теста. Решения пользователя 19.11.2026:
 * - дата файла — константа (fileDate), не «сегодня»: результат не зависит от дня запуска;
 * - заселить (нет открытого проживания): принятые в месяце файла и позже — с даты приёма, остальные — с даты файла;
 * - переселить (живёт в другом общежитии): прежняя запись закрывается датой файла, новая — с неё до прежнего выезда;
 * - выселить (в файле нет): уволенный раньше даты файла — днём после увольнения (жил по день увольнения, деньги не
 *   меняются); уволенный в дату файла и работающие — датой файла;
 * - совпадает — ничего.
 * Сентябрь–октябрь не трогаются: новые въезды и выезды — не раньше 1-го числа месяца файла (иначе — стоп).
 * Повтор на обновлённой базе — пустой план.
 */

/** Житель из файла (уже сопоставлен с сотрудником). */
export interface ISyncFileResident {
  employeeId: number;
  fullName: string;
  /** Общежитие из файла, как написано («Общ. Нагатинская 34»). */
  address: string;
}

export interface ISyncEmployee {
  id: number;
  fullName: string;
  employmentStatus: string | null;
  /** YYYY-MM-DD. */
  hireDate: string | null;
  dismissalDate: string | null;
}

/** Открытое на дату файла проживание общежития. */
export interface ISyncOpenStay {
  id: number;
  employeeId: number;
  address: string;
  checkIn: string;
  checkOut: string | null;
}

export type SyncOperation =
  | { kind: 'add'; employeeId: number; fullName: string; address: string; checkIn: string }
  | { kind: 'move'; employeeId: number; fullName: string; stayId: number; from: string; to: string; date: string;
      stayCheckIn: string; stayCheckOut: string | null }
  | { kind: 'close'; employeeId: number; fullName: string; stayId: number; address: string; checkOut: string;
      stayCheckIn: string; reason: 'dismissed' | 'dismissed_on_file_date' | 'not_in_file' };

export interface ISyncPlan {
  operations: SyncOperation[];
  same: number;
}

const sameAddress = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

const nextDay = (iso: string): string => {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
};

/**
 * План операций. Стоп (Error) — житель файла дважды, у сотрудника несколько открытых общежитий, дата раньше 1-го числа
 * месяца файла или выезд не позже въезда.
 */
export const planDormitorySync = (
  fileResidents: readonly ISyncFileResident[],
  employees: ReadonlyMap<number, ISyncEmployee>,
  openStays: readonly ISyncOpenStay[],
  fileDate: string,
): ISyncPlan => {
  const monthStart = `${fileDate.slice(0, 7)}-01`;
  const operations: SyncOperation[] = [];
  let same = 0;

  const fileByEmployee = new Map<number, ISyncFileResident>();
  for (const resident of fileResidents) {
    if (fileByEmployee.has(resident.employeeId)) throw new Error(`В файле дважды: ${resident.fullName}`);
    fileByEmployee.set(resident.employeeId, resident);
  }
  const openByEmployee = new Map<number, ISyncOpenStay>();
  for (const stay of openStays) {
    if (openByEmployee.has(stay.employeeId)) throw new Error(`Два открытых общежития у сотрудника ${stay.employeeId}`);
    openByEmployee.set(stay.employeeId, stay);
  }

  for (const resident of fileResidents) {
    const open = openByEmployee.get(resident.employeeId);
    if (open && sameAddress(open.address, resident.address)) {
      same += 1;
      continue;
    }
    if (open) {
      if (open.checkIn >= fileDate) throw new Error(`${resident.fullName}: въезд ${open.checkIn} не раньше даты файла — переселять нечего`);
      operations.push({
        kind: 'move', employeeId: resident.employeeId, fullName: resident.fullName, stayId: open.id,
        from: open.address, to: resident.address, date: fileDate, stayCheckIn: open.checkIn, stayCheckOut: open.checkOut,
      });
      continue;
    }
    const employee = employees.get(resident.employeeId);
    const hireDate = employee?.hireDate ?? null;
    const checkIn = hireDate !== null && hireDate >= monthStart && hireDate <= fileDate ? hireDate : fileDate;
    operations.push({ kind: 'add', employeeId: resident.employeeId, fullName: resident.fullName, address: resident.address, checkIn });
  }

  for (const stay of openStays) {
    if (fileByEmployee.has(stay.employeeId)) continue;
    const employee = employees.get(stay.employeeId);
    const dismissal = employee?.dismissalDate ?? null;
    let checkOut = fileDate;
    let reason: 'dismissed' | 'dismissed_on_file_date' | 'not_in_file' = 'not_in_file';
    if (dismissal !== null && dismissal < fileDate) {
      checkOut = nextDay(dismissal);
      reason = 'dismissed';
    } else if (dismissal === fileDate) {
      reason = 'dismissed_on_file_date';
    }
    if (checkOut <= stay.checkIn) throw new Error(`${employee?.fullName ?? stay.employeeId}: выезд ${checkOut} не позже въезда ${stay.checkIn}`);
    operations.push({
      kind: 'close', employeeId: stay.employeeId, fullName: employee?.fullName ?? String(stay.employeeId), stayId: stay.id,
      address: stay.address, checkOut, stayCheckIn: stay.checkIn, reason,
    });
  }

  for (const operation of operations) {
    const date = operation.kind === 'add' ? operation.checkIn : operation.kind === 'move' ? operation.date : operation.checkOut;
    if (date < monthStart) throw new Error(`${operation.fullName}: дата ${date} раньше ${monthStart} — закрытые месяцы не трогаем`);
  }
  return { operations, same };
};
