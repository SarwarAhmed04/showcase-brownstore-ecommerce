import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { translations } from "../i18n";
import { getCookie, setCookie } from "../lib/cookies";

const LangContext = createContext(null);

export function LangProvider({ children }) {
  const [lang, setLang] = useState(
    () => getCookie("brownstore_lang") || "ku"
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
      t: translations[lang] || translations.ku,
      dir: lang === "en" ? "ltr" : "rtl",
    }),
    [lang]
  );

  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
}

export function useLang() {
  return useContext(LangContext);
}
