import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { api } from "../../api";
import { useAuth } from "../../context/AuthContext";
import { useLang } from "../../context/LangContext";
import { tName } from "../../i18n";
import Spinner from "../../components/Spinner";

function Row({ product, onSaved, t, lang }) {
  const [sku, setSku] = useState(product.sku || "");
  const [price, setPrice] = useState(product.sellingPrice ?? product.price ?? 0);
  const [stock, setStock] = useState(product.stock ?? 0);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setSku(product.sku || "");
    setPrice(product.sellingPrice ?? product.price ?? 0);
    setStock(product.stock ?? 0);
  }, [product]);

  async function save() {
    setBusy(true);
    setStatus("");
    try {
      const data = await api.patchProduct(product.id, {
        sku,
        price: Number(price),
        stock: Number(stock),
      });
      onSaved(data.product);
      setStatus(t.saved);
    } catch (err) {
      setStatus(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr className="border-b border-brown/5 align-middle">
      <td className="p-3">
        <div className="flex items-center gap-3">
          <img
            src={product.image || "/logo.png"}
            alt=""
            className="h-12 w-12 rounded-xl object-cover bg-cream"
          />
          <div>
            <p className="max-w-56 truncate font-medium">
              {tName(product.name, lang)}
            </p>
            <p className="text-xs text-brown/40">
              {t.source}: {product.itemCode || "—"}
            </p>
          </div>
        </div>
      </td>
      <td className="p-3">
        <input
          value={sku}
          onChange={(e) => setSku(e.target.value)}
          className="w-28 rounded-lg border border-brown/10 px-2 py-1 text-sm"
        />
      </td>
      <td className="p-3">
        <input
          type="number"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          className="w-28 rounded-lg border border-brown/10 px-2 py-1 text-sm"
        />
      </td>
      <td className="p-3">
        <input
          type="number"
          value={stock}
          onChange={(e) => setStock(e.target.value)}
          className="w-20 rounded-lg border border-brown/10 px-2 py-1 text-sm"
        />
      </td>
      <td className="p-3">
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="rounded-full bg-brown px-3 py-1.5 text-xs font-semibold text-cream disabled:opacity-50"
        >
          {t.save}
        </button>
        {status ? <p className="mt-1 text-xs text-tan">{status}</p> : null}
      </td>
    </tr>
  );
}

export default function AdminProducts() {
  const { t, lang } = useLang();
  const { user, ready, logout } = useAuth();
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState("");
  const [data, setData] = useState({ products: [], pagination: { pages: 1, total: 0 } });
  const [loading, setLoading] = useState(true);

  function load(nextPage = page, query = q) {
    setLoading(true);
    api
      .adminProducts({ page: nextPage, q: query, limit: 20 })
      .then(setData)
      .catch((err) => setMessage(err.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    if (user) load(1, "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  if (!ready) return <Spinner label={t.loading} />;
  if (!user) return <Navigate to="/admin/login" replace />;

  async function sync() {
    setSyncing(true);
    setMessage("");
    try {
      const result = await api.sync();
      setMessage(`${result.products} ${t.products}`);
      load(page, q);
    } catch (err) {
      setMessage(err.message);
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl">{t.admin}</h1>
          <p className="text-sm text-brown/50">{user.email}</p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={sync}
            disabled={syncing}
            className="rounded-full bg-tan px-4 py-2 text-sm font-semibold text-brown disabled:opacity-60"
          >
            {syncing ? t.syncing : t.sync}
          </button>
          <button
            type="button"
            onClick={logout}
            className="rounded-full bg-white px-4 py-2 text-sm ring-1 ring-brown/10"
          >
            {t.logout}
          </button>
        </div>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          setPage(1);
          load(1, q);
        }}
        className="mb-4 flex gap-2"
      >
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t.search}
          className="w-full max-w-sm rounded-full border border-brown/10 bg-white px-4 py-2 text-sm"
        />
        <button className="rounded-full bg-brown px-4 py-2 text-sm text-cream" type="submit">
          {t.search.split(" ")[0]}
        </button>
      </form>

      {message ? <p className="mb-3 text-sm text-brown/70">{message}</p> : null}

      <div className="overflow-x-auto rounded-3xl bg-white shadow-sm ring-1 ring-brown/5">
        {loading ? (
          <Spinner label={t.loading} />
        ) : (
          <table className="min-w-full text-sm">
            <thead className="bg-cream text-left text-xs uppercase tracking-wide text-brown/60">
              <tr>
                <th className="p-3">{t.products}</th>
                <th className="p-3">{t.sku}</th>
                <th className="p-3">{t.price}</th>
                <th className="p-3">{t.stock}</th>
                <th className="p-3">{t.save}</th>
              </tr>
            </thead>
            <tbody>
              {data.products.map((p) => (
                <Row
                  key={p.id}
                  product={p}
                  t={t}
                  lang={lang}
                  onSaved={(updated) =>
                    setData((prev) => ({
                      ...prev,
                      products: prev.products.map((item) =>
                        item.id === updated.id ? updated : item
                      ),
                    }))
                  }
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {data.pagination.pages > 1 && (
        <div className="mt-4 flex justify-center gap-2">
          {Array.from({ length: data.pagination.pages }, (_, i) => i + 1)
            .filter((n) => n === 1 || n === data.pagination.pages || Math.abs(n - page) <= 2)
            .map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => {
                  setPage(n);
                  load(n, q);
                }}
                className={`h-9 min-w-9 rounded-full ${
                  n === page ? "bg-brown text-cream" : "bg-white"
                }`}
              >
                {n}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
