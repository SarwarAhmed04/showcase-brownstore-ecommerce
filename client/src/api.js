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
    throw new Error(json.message || `Request failed (${res.status})`);
  }
  return json;
}

export const api = {
  products: (params = {}) => {
    const qs = new URLSearchParams(
      Object.fromEntries(
        Object.entries(params).filter(([, v]) => v !== "" && v != null)
      )
    );
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
  patchProduct: (id, body) =>
    request(`/api/admin/products/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  sync: () => request("/api/admin/sync", { method: "POST" }),
};
