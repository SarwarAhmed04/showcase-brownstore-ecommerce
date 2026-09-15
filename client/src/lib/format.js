import { formatPrice } from "../i18n";

export const CURRENCY = "IQD";

export const money = (n) => {
  const lang = typeof document !== "undefined" ? document.documentElement.lang || "en" : "en";
  return formatPrice(n, lang);
};

export const moneyShort = (n) => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M ${CURRENCY}`;
  if (n >= 1_000) return `${Math.round(n / 1000)}K ${CURRENCY}`;
  return money(n);
};

export const slugify = (s) =>
  String(s || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
