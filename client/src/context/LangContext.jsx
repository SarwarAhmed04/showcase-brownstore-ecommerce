import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { translations } from "../i18n";
import { getCookie, setCookie } from "../lib/cookies";

const LangContext = createContext(null);

export function LangProvider({ children }) {
  const [lang, setLang] = useState(
    () => getCookie("brownstore_lang") || "ar"
  );

  useEffect(() => {
    setCookie("brownstore_lang", lang);
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "en" ? "ltr" : "rtl";
  }, [lang]);

  const value = useMemo(
    () => ({
      lang,
      setLang,
      t: translations[lang] || translations.ar,
      dir: lang === "en" ? "ltr" : "rtl",
    }),
    [lang]
  );

  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
}

/**
 * Returns lang helpers. When context is briefly null (Vite Fast Refresh remounts
 * LangProvider after i18n/HMR), fall back instead of throwing — otherwise
 * AdminShell does `const { t } = useLang()` and the entire admin UI goes blank.
 */
export function useLang() {
  const ctx = useContext(LangContext);
  if (ctx) return ctx;
  const lang = typeof document !== "undefined" ? document.documentElement.lang || "ar" : "ar";
  const safeLang = translations[lang] ? lang : "ar";
  return {
    lang: safeLang,
    setLang: () => {},
    t: translations[safeLang] || translations.ar,
    dir: safeLang === "en" ? "ltr" : "rtl",
  };
}
