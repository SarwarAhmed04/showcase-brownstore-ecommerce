const TOKEN_KEY = "brownstore_token";

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || "";
}

export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !(options.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(path, { ...options, headers });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.message || `Request failed (${res.status})`);
    err.details = json.details;
    throw err;
  }
  return json;
}

export const api = {
  products: (params = {}) => {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === "" || value == null || value === false) continue;
      if (Array.isArray(value)) {
        value.filter((item) => item !== "" && item != null).forEach((item) => qs.append(key, String(item)));
      } else {
        qs.set(key, String(value));
      }
    }
    return request(`/api/products?${qs}`);
  },
  product: (id) => request(`/api/products/${id}`),
  categories: () => request("/api/categories"),
  login: (email, password) =>
    request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  me: () => request("/api/auth/me"),
  adminProducts: (params = {}) => {
    const qs = new URLSearchParams(
      Object.fromEntries(
        Object.entries(params).filter(([, v]) => v !== "" && v != null)
      )
    );
    return request(`/api/admin/products?${qs}`);
  },
  adminProduct: (id) => request(`/api/admin/products/${encodeURIComponent(id)}`),
  patchProduct: (id, body) =>
    request(`/api/admin/products/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  sync: () => request("/api/admin/sync", { method: "POST" }),
  adminStats: () => request("/api/admin/stats"),
  adminCategories: () => request("/api/admin/categories"),
  patchCategory: (id, body) =>
    request(`/api/admin/categories/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  uploadCategoryImage: (id, image) =>
    request(`/api/admin/categories/${encodeURIComponent(id)}/image`, {
      method: "POST",
      body: JSON.stringify({ image }),
    }),
  patchSettings: (body) =>
    request("/api/admin/settings", {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  adminAccounts: () => request("/api/admin/accounts"),
  createAdminAccount: (body) =>
    request("/api/admin/accounts", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  deleteAdminAccount: (id) =>
    request(`/api/admin/accounts/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  adminPartners: () => request("/api/admin/partners"),
  adminCommissions: (partner) =>
    request(
      partner
        ? `/api/admin/commissions?partner=${encodeURIComponent(partner)}`
        : "/api/admin/commissions"
    ),
  saveCommission: (body) =>
    request("/api/admin/commissions", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  patchCommission: (id, body) =>
    request(`/api/admin/commissions/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteCommission: (id) =>
    request(`/api/admin/commissions/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  regeneratePartnerApiKey: (slug, pin) =>
    request(`/api/admin/partners/${encodeURIComponent(slug)}/api-key`, {
      method: "POST",
      body: JSON.stringify({ pin }),
    }),
  adminPlatforms: () => request("/api/admin/platforms"),
  adminPlatform: (slug) => request(`/api/admin/platforms/${encodeURIComponent(slug)}`),
  createPlatform: (body) =>
    request("/api/admin/platforms", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  patchPlatform: (slug, body) =>
    request(`/api/admin/platforms/${encodeURIComponent(slug)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deletePlatform: (slug) =>
    request(`/api/admin/platforms/${encodeURIComponent(slug)}`, {
      method: "DELETE",
    }),
  adminPlatformProducts: (slug, params = {}) => {
    const qs = new URLSearchParams(
      Object.fromEntries(
        Object.entries(params).filter(([, v]) => v !== "" && v != null)
      )
    );
    const suffix = qs.toString();
    return request(
      `/api/admin/platforms/${encodeURIComponent(slug)}/products${suffix ? `?${suffix}` : ""}`
    );
  },
  adminPlatformProduct: (slug, id) =>
    request(
      `/api/admin/platforms/${encodeURIComponent(slug)}/products/${encodeURIComponent(id)}`
    ),
  patchPlatformProduct: (slug, id, body) =>
    request(
      `/api/admin/platforms/${encodeURIComponent(slug)}/products/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        body: JSON.stringify(body),
      }
    ),
  resetPlatformProduct: (slug, id) =>
    request(
      `/api/admin/platforms/${encodeURIComponent(slug)}/products/${encodeURIComponent(id)}`,
      { method: "DELETE" }
    ),
  createEnquiry: (body) =>
    request("/api/enquiries", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  adminActivity: (params = {}) => {
    const qs = new URLSearchParams(
      Object.fromEntries(
        Object.entries(params).filter(([, v]) => v !== "" && v != null)
      )
    );
    const suffix = qs.toString();
    return request(`/api/admin/activity${suffix ? `?${suffix}` : ""}`);
  },
};
