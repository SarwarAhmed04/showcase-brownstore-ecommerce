import { createContext, useContext, useEffect, useState } from "react";
import { getCookie, setCookie } from "../lib/cookies";

const ThemeContext = createContext({
  theme: "espresso",
  toggleTheme: () => {},
  setTheme: () => {},
});

const STORAGE_KEY = "brownstore-theme";

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(() => {
    try {
      const saved = getCookie(STORAGE_KEY);
      if (saved === "cream" || saved === "espresso") return saved;
    } catch {
      /* ignore */
    }
    return "espresso";
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      setCookie(STORAGE_KEY, theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  function setTheme(next) {
    setThemeState(next === "cream" ? "cream" : "espresso");
  }

  function toggleTheme() {
    setThemeState((current) => (current === "espresso" ? "cream" : "espresso"));
  }

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
