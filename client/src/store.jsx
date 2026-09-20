import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { useSaved } from "./lib/hooks";

const StoreContext = createContext(null);

export function StoreProvider({ children }) {
  const saved = useSaved();
  const [quickView, setQuickView] = useState(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const closeQuickView = useCallback(() => setQuickView(null), []);

  const value = useMemo(
    () => ({
      saved,
      quickView,
      openQuickView: setQuickView,
      closeQuickView,
      searchOpen,
      setSearchOpen,
    }),
    [saved, quickView, closeQuickView, searchOpen]
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore must be used inside <StoreProvider>");
  return ctx;
}
