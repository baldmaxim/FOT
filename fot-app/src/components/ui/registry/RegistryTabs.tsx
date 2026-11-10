import { useEffect, useRef, type KeyboardEvent, type ReactElement } from 'react';

import styles from './RegistryTabs.module.css';

export interface IRegistryTab<Key extends string> {
  key: Key;
  label: string;
}

interface IRegistryTabsProps<Key extends string> {
  tabs: ReadonlyArray<IRegistryTab<Key>>;
  active: Key;
  onChange: (tab: Key) => void;
  tabId: (tab: Key) => string;
  panelId: (tab: Key) => string;
  /** aria-label полосы вкладок: «Разделы доплаты». */
  label: string;
}

/**
 * Вкладки окна-реестра («Доплата», «Удержания»): один стоп Tab, между ними — стрелки, Home и End (выбор сразу, как
 * по клику). Панели — у вызывающего: className tabPanel из RegistryTabs.module.css, hidden у неактивных.
 */
export const RegistryTabs = <Key extends string,>({
  tabs, active, onChange, tabId, panelId, label,
}: IRegistryTabsProps<Key>): ReactElement => {
  const tabRefs = useRef<Partial<Record<Key, HTMLButtonElement | null>>>({});

  // На 360px вкладки не влезают: выбранная, даже обрезанная, показывается целиком.
  useEffect(() => {
    tabRefs.current[active]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = tabs.findIndex(item => item.key === active);
    const last = tabs.length - 1;
    const moves: Partial<Record<string, number>> = {
      ArrowRight: index === last ? 0 : index + 1,
      ArrowLeft: index === 0 ? last : index - 1,
      Home: 0,
      End: last,
    };
    const next = moves[event.key];
    if (next === undefined) return;
    event.preventDefault();
    const { key } = tabs[next];
    onChange(key);
    tabRefs.current[key]?.focus();
  };

  return (
    <div className={styles.tabs} role="tablist" aria-label={label} onKeyDown={handleKeyDown}>
      {tabs.map(item => {
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
