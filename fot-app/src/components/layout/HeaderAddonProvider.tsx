import type { FC, ReactNode } from 'react';
import { HeaderAddonContext } from './HeaderAddonContext';

interface IHeaderAddonProviderProps {
  setAddon: (node: ReactNode | null) => void;
  children: ReactNode;
}

export const HeaderAddonProvider: FC<IHeaderAddonProviderProps> = ({ setAddon, children }) => {
  return (
    <HeaderAddonContext.Provider value={{ setAddon }}>
      {children}
    </HeaderAddonContext.Provider>
  );
};
