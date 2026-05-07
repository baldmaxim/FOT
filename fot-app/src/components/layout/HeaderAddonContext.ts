import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

interface IHeaderAddonContextValue {
  setAddon: (node: ReactNode | null) => void;
}

export const HeaderAddonContext = createContext<IHeaderAddonContextValue>({ setAddon: () => {} });

export const useHeaderAddonState = (): { addon: ReactNode | null; setAddon: (n: ReactNode | null) => void } => {
  const [addon, setAddon] = useState<ReactNode | null>(null);
  return { addon, setAddon };
};

export const useHeaderAddon = (node: ReactNode | null): void => {
  const { setAddon } = useContext(HeaderAddonContext);
  useEffect(() => {
    setAddon(node);
    return () => setAddon(null);
  }, [node, setAddon]);
};
