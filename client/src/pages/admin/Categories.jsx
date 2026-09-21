import { useEffect, useState } from "react";
import { api } from "../../api";
import { useLang } from "../../context/LangContext";
import { tName } from "../../i18n";
import { imgUrl } from "../../lib/img";
import Spinner from "../../components/Spinner";

function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Could not read image"));
    reader.readAsDataURL(file);
  });
}

function CategoryCard({ item, t, lang, onUpdated }) {
  const [name, setName] = useState({
    ku: item.overrides?.name?.ku || "",
    en: item.overrides?.name?.en || "",
    ar: item.overrides?.name?.ar || "",
  });
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  useEffect(() => {
    setName({
      ku: item.overrides?.name?.ku || "",
      en: item.overrides?.name?.en || "",
      ar: item.overrides?.name?.ar || "",
    });
  }, [item]);

  async function saveNames() {
    setBusy(true);
    setStatus("");
    try {
      const data = await api.patchCategory(item.id, { name });
      onUpdated(data.category);
      setStatus(t.saved);
    } catch (err) {
      setStatus(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function onFile(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy(true);
    setStatus("");
    try {
      const image = await readFile(file);
      const data = await api.uploadCategoryImage(item.id, image);
      onUpdated(data.category);
      setStatus(t.saved);
    } catch (err) {
      setStatus(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function restoreImage() {
    setBusy(true);
    setStatus("");
    try {
      const data = await api.patchCategory(item.id, { clearImage: true });
      onUpdated(data.category);
      setStatus(t.saved);
    } catch (err) {
      setStatus(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="rounded-3xl bg-white p-4 shadow-sm ring-1 ring-brown/5">
      <div className="flex gap-4">
        <div className="relative h-24 w-24 shrink-0 overflow-hidden rounded-2xl bg-cream">
          {item.image ? (
            <img src={imgUrl(item.image)} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-brown/30">
              —
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-medium">{tName(item.name, lang)}</p>
          <p className="mt-1 text-[11px] text-brown/40">
            {t.source}: {tName(item.sourceName, lang) || item.id}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <label className="cursor-pointer rounded-full bg-brown px-3 py-1.5 text-xs font-semibold text-cream">
              {t.changeImage}
              <input type="file" accept="image/*" className="hidden" onChange={onFile} disabled={busy} />
            </label>
            {item.customImage ? (
              <button
                type="button"
                onClick={restoreImage}
                disabled={busy}
                className="rounded-full bg-white px-3 py-1.5 text-xs font-semibold text-brown ring-1 ring-brown/10"
              >
                {t.originalImage}
              </button>
            ) : null}
          </div>
        </div>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-3">
        <label className="text-xs text-brown/50">
          {t.nameKu}
          <input
            value={name.ku}
            onChange={(e) => setName((prev) => ({ ...prev, ku: e.target.value }))}
            placeholder={item.sourceName?.ku || ""}
            className="mt-1 w-full rounded-xl border border-brown/10 px-3 py-2 text-sm text-brown"
          />
        </label>
        <label className="text-xs text-brown/50">
          {t.nameEn}
          <input
            value={name.en}
            onChange={(e) => setName((prev) => ({ ...prev, en: e.target.value }))}
            placeholder={item.sourceName?.en || ""}
            className="mt-1 w-full rounded-xl border border-brown/10 px-3 py-2 text-sm text-brown"
          />
        </label>
        <label className="text-xs text-brown/50">
          {t.nameAr}
          <input
            value={name.ar}
            dir="rtl"
            onChange={(e) => setName((prev) => ({ ...prev, ar: e.target.value }))}
            placeholder={item.sourceName?.ar || ""}
            className="mt-1 w-full rounded-xl border border-brown/10 px-3 py-2 text-sm text-brown"
          />
        </label>
      </div>

      <div className="mt-3 flex items-center justify-between gap-3">
        {status ? <p className="text-xs text-tan">{status}</p> : <span />}
        <button
          type="button"
          onClick={saveNames}
          disabled={busy}
          className="rounded-full bg-brown px-4 py-1.5 text-xs font-semibold text-cream disabled:opacity-50"
        >
          {t.save}
        </button>
      </div>
    </article>
  );
}

export default function AdminCategories() {
  const { t, lang } = useLang();
  const [limit, setLimit] = useState(0);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .adminCategories()
      .then((data) => {
        setLimit(Number(data.categoryLimit) || 0);
        setItems(data.categories || []);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  async function chooseLimit(next) {
    const prev = limit;
    setLimit(next);
    try {
      await api.patchSettings({ categoryLimit: next });
    } catch (err) {
      setLimit(prev);
      setError(err.message);
    }
  }

  function onUpdated(updated) {
    setItems((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
  }

  if (loading) return <Spinner label={t.loading} />;

  return (
    <div>
      <div className="mb-6">
        <h2 className="font-display text-3xl">{t.categoriesPage}</h2>
        <p className="mt-1 text-sm text-brown/50">{t.customizeCategories}</p>
      </div>

      {error ? <p className="mb-4 text-sm text-red-700">{error}</p> : null}

      <section className="mb-8 rounded-3xl bg-white p-5 shadow-sm ring-1 ring-brown/5">
        <p className="text-[11px] font-semibold tracking-[0.2em] text-tan uppercase">
          {t.categoryLimit}
        </p>
        <p className="mt-2 max-w-xl text-sm text-brown/55">{t.categoryLimitHint}</p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <select
            value={limit}
            onChange={(e) => chooseLimit(Number(e.target.value))}
            className="rounded-full border border-brown/10 bg-cream px-4 py-2 text-sm font-semibold text-brown"
          >
            <option value={0}>{t.showAllCategories}</option>
            {items.map((_, i) => (
              <option key={i + 1} value={i + 1}>
                {i + 1}
              </option>
            ))}
          </select>
          <p className="text-sm text-brown/45">
            {limit > 0
              ? `${Math.min(limit, items.length)} / ${items.length}`
              : `${items.length} / ${items.length}`}
          </p>
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        {items.map((item) => (
          <CategoryCard key={item.id} item={item} t={t} lang={lang} onUpdated={onUpdated} />
        ))}
      </div>
    </div>
  );
}
