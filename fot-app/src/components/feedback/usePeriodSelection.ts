import { useCallback, useState } from 'react';
import { type PresetKey, presetRange } from './deptStats';

const STORAGE_KEY = 'fb-tasks-period';

interface IStored {
  mode: 'preset' | 'custom';
  preset?: PresetKey;
  from?: string;
  to?: string;
}

interface IPeriodSelection {
  from: string;
  to: string;
  setPreset: (key: PresetKey) => void;
  setDates: (from: string, to: string) => void;
}

// Выбор периода с сохранением в localStorage: пресет хранится по ключу (пересчёт от сегодня),
// произвольные даты — как есть. По умолчанию «Сегодня».
export const usePeriodSelection = (today: string): IPeriodSelection => {
  const [range, setRange] = useState<{ from: string; to: string }>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const s = JSON.parse(raw) as IStored;
        if (s.mode === 'preset' && s.preset) return presetRange(s.preset, today);
        if (s.mode === 'custom' && s.from && s.to) return { from: s.from, to: s.to };
      }
    } catch {
      /* ignore */
    }
    return presetRange('today', today);
  });

  const setPreset = useCallback((key: PresetKey) => {
    setRange(presetRange(key, today));
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ mode: 'preset', preset: key }));
    } catch {
      /* ignore */
    }
  }, [today]);

  const setDates = useCallback((from: string, to: string) => {
    setRange({ from, to });
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ mode: 'custom', from, to }));
    } catch {
      /* ignore */
    }
  }, []);

  return { from: range.from, to: range.to, setPreset, setDates };
};
