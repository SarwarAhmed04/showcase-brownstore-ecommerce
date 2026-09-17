function cookieMap() {
  return document.cookie.split(";").reduce((acc, part) => {
    const index = part.indexOf("=");
    if (index < 0) return acc;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) return acc;
    try {
      acc[decodeURIComponent(key)] = decodeURIComponent(value);
    } catch {
      acc[key] = value;
    }
    return acc;
  }, {});
}

export function getCookie(name) {
  try {
    return cookieMap()[name] || "";
  } catch {
    return "";
  }
}

export function setCookie(name, value, maxAgeSec = 60 * 60 * 24 * 365) {
  try {
    document.cookie = `${encodeURIComponent(name)}=${encodeURIComponent(
      String(value)
    )}; Path=/; Max-Age=${Math.max(0, maxAgeSec)}; SameSite=Lax`;
  } catch {
    /* cookies unavailable */
  }
}

export function removeCookie(name) {
  setCookie(name, "", 0);
}

const LEGACY_KEYS = ["brownstore_lang", "brownstore-theme", "bs:saved"];

export function migrateLegacyStorage() {
  try {
    for (const key of LEGACY_KEYS) {
      const existing = getCookie(key);
      const legacy = localStorage.getItem(key);
      if (!existing && legacy) setCookie(key, legacy);
      localStorage.removeItem(key);
    }
    localStorage.removeItem("brownstore_token");
  } catch {
    /* ignore */
  }
}
