import { useMemo, useState } from 'react';

import type { IRegistryMonths } from '../components/ui/registry/RegistryPanel';
import { moscowTodayIso } from '../utils/moscowDate';
import { registryMonthOptions, registryMonthsParam } from '../utils/payrollRegistries';

/**
 * Выбор месяцев таблицы «Справочника»: по умолчанию — текущий месяц (МСК); «Весь период» не выбирается.
 * param — значение ?months= для таблиц с суммами из условий оплаты (входит в ключ запроса).
 */
export const useRegistryMonths = (): IRegistryMonths & { param: string } => {
  const [currentMonth] = useState(() => moscowTodayIso().slice(0, 7));
  const [value, setValue] = useState<string[]>([currentMonth]);
  const options = useMemo(() => registryMonthOptions(currentMonth), [currentMonth]);
  return { value, options, onChange: setValue, param: registryMonthsParam(value) };
};
