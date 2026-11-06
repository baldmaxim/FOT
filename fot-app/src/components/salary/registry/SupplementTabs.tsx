import { useEffect, useRef, type FC, type KeyboardEvent } from 'react';

import styles from './SupplementTabs.module.css';

export type SupplementTab = 'all' | 'planned' | 'apartments';

const SUPPLEMENT_TABS: ReadonlyArray<{ key: SupplementTab; label: string }> = [
  { key: 'all', label: 'Доплата за месяц' },
  { key: 'planned', label: 'Плановые доплаты' },
  { key: 'apartments', label: 'Квартира' },
];

interface ISupplementTabsProps {
  active: SupplementTab;
  onChange: (tab: SupplementTab) => void;
  tabId: (tab: SupplementTab) => string;
  panelId: (tab: SupplementTab) => string;
}

/** Вкладки окна «Доплата»: один стоп Tab, между ними — стрелки, Home и End (выбор сразу, как по клику). */
export const SupplementTabs: FC<ISupplementTabsProps> = ({ active, onChange, tabId, panelId }) => {
  const tabRefs = useRef<Partial<Record<SupplementTab, HTMLButtonElement | null>>>({});

  // На 360px вкладки не влезают: выбранная, даже обрезанная, показывается целиком.
  useEffect(() => {
    tabRefs.current[active]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = SUPPLEMENT_TABS.findIndex(item => item.key === active);
    const last = SUPPLEMENT_TABS.length - 1;
    const moves: Partial<Record<string, number>> = {
      ArrowRight: index === last ? 0 : index + 1,
      ArrowLeft: index === 0 ? last : index - 1,
      Home: 0,
      End: last,
    };
    const next = moves[event.key];
    if (next === undefined) return;
    event.preventDefault();
    const { key } = SUPPLEMENT_TABS[next];
    onChange(key);
    tabRefs.current[key]?.focus();
  };

  return (
    <div className={styles.tabs} role="tablist" aria-label="Разделы доплаты" onKeyDown={handleKeyDown}>
      {SUPPLEMENT_TABS.map(item => {
        const selected = item.key === active;
        return (
          <button
            key={item.key}
            ref={element => { tabRefs.current[item.key] = element; }}
            type="button"
            role="tab"
            id={tabId(item.key)}
            aria-selected={selected}
            aria-controls={panelId(item.key)}
            tabIndex={selected ? 0 : -1}
            className={selected ? `${styles.tab} ${styles.tabActive}` : styles.tab}
            onClick={() => onChange(item.key)}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
};
