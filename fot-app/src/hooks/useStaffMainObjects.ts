import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { employeeService, type IEmployeeMainObjects } from '../services/employeeService';

const REFRESH_MS = 60_000;

const moscowDate = (): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date());

/** Московская дата, перепроверяемая раз в минуту: после полуночи меняется ключ запроса. */
const useMoscowDate = (): string => {
  const [date, setDate] = useState(moscowDate);
  useEffect(() => {
    const timer = window.setInterval(() => {
      const next = moscowDate();
      setDate(prev => (prev === next ? prev : next));
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);
  return date;
};

export const STAFF_MAIN_OBJECTS_QUERY_KEY = 'employee-main-objects';

/**
 * Столбец «Объект» для сотрудников текущей страницы. Тот же алгоритм, что в Excel;
 * при успешном обновлении таблица может отставать до 60 секунд.
 */
export const useStaffMainObjects = (employeeIds: number[]) => {
  const mskDate = useMoscowDate();
  return useQuery<IEmployeeMainObjects>({
    queryKey: [STAFF_MAIN_OBJECTS_QUERY_KEY, mskDate, employeeIds],
    queryFn: () => employeeService.getMainObjects(employeeIds),
    enabled: employeeIds.length > 0,
    // Прежние значения остаются на экране, пока идёт перезапрос: ячейки не мигают,
    // высота строк и прокрутка не меняются.
    placeholderData: previous => previous,
    staleTime: REFRESH_MS,
    refetchInterval: REFRESH_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
};
