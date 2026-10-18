import { createContext, useContext, useMemo, useState } from "react";

const PlatformNavContext = createContext(null);

export function PlatformNavProvider({ children }) {
  const [nav, setNav] = useState(null);
  const value = useMemo(() => ({ nav, setNav }), [nav]);
  return <PlatformNavContext.Provider value={value}>{children}</PlatformNavContext.Provider>;
}

export function usePlatformNav() {
  const value = useContext(PlatformNavContext);
  if (!value) throw new Error("Platform navigation is unavailable");
  return value;
}
