import { createContext, useContext, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Outlet } from "react-router-dom";
import { Moon, Sun } from "lucide-react";
import { useLang } from "./context/LangContext";

export const ADMIN_THEME_KEY = "brownstore-admin-theme";

const AdminThemeContext = createContext(null);

function storedTheme() {
  try {
    return localStorage.getItem(ADMIN_THEME_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

const THEME_FADE_MS = 240;

export function AdminThemeProvider({ children }) {
  const [theme, setTheme] = useState(storedTheme);
  const painted = useRef(false);

  useLayoutEffect(() => {
    const root = document.documentElement;
    const animate =
      painted.current &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    painted.current = true;

    let timer;
    if (animate) {
      root.classList.add("admin-theme-switching");
      root.getBoundingClientRect();
    }
    root.classList.toggle("admin-dark", theme === "dark");
    root.dataset.adminTheme = theme;
    try {
      localStorage.setItem(ADMIN_THEME_KEY, theme);
    } catch {
      /* private browsing */
    }
    if (animate) {
      timer = window.setTimeout(() => {
        root.classList.remove("admin-theme-switching");
      }, THEME_FADE_MS);
    }
    return () => {
      if (timer) window.clearTimeout(timer);
    };
  }, [theme]);

  useLayoutEffect(() => {
    return () => {
      const root = document.documentElement;
      root.classList.remove("admin-dark", "admin-theme-switching");
      delete root.dataset.adminTheme;
    };
  }, []);

  const value = useMemo(
    () => ({
      theme,
      dark: theme === "dark",
      toggle() {
        setTheme((current) => (current === "dark" ? "light" : "dark"));
      },
    }),
    [theme]
  );

  return <AdminThemeContext.Provider value={value}>{children}</AdminThemeContext.Provider>;
}

export function AdminThemeRoot() {
  return (
    <AdminThemeProvider>
      <Outlet />
    </AdminThemeProvider>
  );
}

export function useAdminTheme() {
  const value = useContext(AdminThemeContext);
  if (!value) throw new Error("Admin theme is unavailable");
  return value;
}

export function AdminThemeToggle() {
  const { t } = useLang();
  const { dark, toggle } = useAdminTheme();
  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={dark}
      aria-label={dark ? t.lightMode : t.darkMode}
      title={dark ? t.lightMode : t.darkMode}
      className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-brown/70 ring-1 ring-brown/10 transition hover:bg-brown/[0.04] hover:text-brown"
    >
      <span className="relative h-4 w-4">
        <Sun
          className={`absolute inset-0 h-4 w-4 transition-all duration-200 ease-out ${
            dark ? "rotate-0 scale-100 opacity-100" : "rotate-90 scale-50 opacity-0"
          }`}
          strokeWidth={1.8}
        />
        <Moon
          className={`absolute inset-0 h-4 w-4 transition-all duration-200 ease-out ${
            dark ? "-rotate-90 scale-50 opacity-0" : "rotate-0 scale-100 opacity-100"
          }`}
          strokeWidth={1.8}
        />
      </span>
    </button>
  );
}
