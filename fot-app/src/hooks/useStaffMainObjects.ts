import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { employeeService, type IEmployeeMainObjects } from '../services/employeeService';

const DATE_CHECK_MS = 60_000;
/** Снимок пересчитывается ночью — чаще перезапрашивать незачем. */
const STALE_MS = 10 * 60_000;

const moscowDate = (): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date());

/** Московская дата, перепроверяемая раз в минуту: после полуночи меняется ключ запроса. */
const useMoscowDate = (): string => {
  const [date, setDate] = useState(moscowDate);
  useEffect(() => {
    const timer = window.setInterval(() => {
      const next = moscowDate();
      setDate(prev => (prev === next ? prev : next));
    }, DATE_CHECK_MS);
    return () => window.clearInterval(timer);
  }, []);
  return date;
};

export const STAFF_MAIN_OBJECTS_QUERY_KEY = 'employee-main-objects';

/**
 * Столбец «Объект» для сотрудников текущей страницы — из ночного снимка сервера (тот же
 * источник, что у Excel-выгрузки). Обновляется при возврате во вкладку и раз в 10 минут
 * при следующем обращении; после московской полуночи ключ меняется и данные грузятся заново.
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
    staleTime: STALE_MS,
    refetchOnWindowFocus: true,
  });
};
