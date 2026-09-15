import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../../api";
import { useLang } from "../../context/LangContext";
import { tName } from "../../i18n";
import Spinner from "../../components/Spinner";

const GROUPS = [
  { id: "", key: "activityAll" },
  { id: "commission", key: "commission" },
  { id: "api", key: "activityFilterApi" },
  { id: "account", key: "accounts" },
  { id: "product", key: "products" },
  { id: "category", key: "categoriesPage" },
  { id: "sync", key: "sync" },
  { id: "enquiry", key: "reserveItem" },
];

function formatWhen(value, lang) {
  if (!value) return "—";
  const locale = lang === "ar" ? "ar-IQ" : lang === "ku" ? "en-GB" : "en-US";
  return new Date(value).toLocaleString(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function formatRate(value) {
  const n = Number(value) || 0;
  return n > 0 ? `+${n}%` : `${n}%`;
}

function scopeLabel(t, scope) {
  if (scope === "all") return t.allCommission;
  if (scope === "subcategory") return t.subCategory;
  if (scope === "collection") return t.collection;
  return t.category;
}

function actionTitle(item, t) {
  switch (item.action) {
    case "commission.save":
      return t.activityActionCommissionSave;
    case "commission.toggle":
      return t.activityActionCommissionToggle;
    case "commission.delete":
      return t.activityActionCommissionDelete;
    case "partner.api_key":
      return item.meta?.regenerated ? t.activityActionApiKeyRegen : t.activityActionApiKeyNew;
    case "account.create":
      return t.activityActionAccountCreate;
    case "account.delete":
      return t.activityActionAccountDelete;
    case "product.update":
      return t.activityActionProductUpdate;
    case "catalog.sync":
      return t.activityActionCatalogSync;
    case "category.update":
      return t.activityActionCategoryUpdate;
    case "category.image":
      return t.activityActionCategoryImage;
    case "settings.update":
      return t.activityActionSettings;
    case "enquiry.create":
      return t.activityActionEnquiry;
    default:
      return item.action;
  }
}

function fieldLabel(t, field) {
  if (field === "sku") return t.sku;
  if (field === "price") return t.price;
  if (field === "stock") return t.stock;
  if (field === "outOfStock") return t.availability;
  return field;
}

function formatValue(t, field, value, lang) {
  if (field === "outOfStock") return value ? t.outOfStock : t.inStock;
  if (field === "price" && value != null && value !== "") {
    return Number(value).toLocaleString(lang === "ar" ? "ar-IQ" : "en-US");
  }
  if (value == null || value === "") return "—";
  return String(value);
}

function activityDetail(item, t, lang) {
  const meta = item.meta || {};
  const partner = meta.partnerName || meta.partner || "";
  const target =
    meta.scope === "all" ? t.allProducts : tName(meta.targetName, lang) || "";

  switch (item.action) {
    case "commission.save":
    case "commission.toggle":
    case "commission.delete": {
      const bits = [partner, scopeLabel(t, meta.scope), target, formatRate(meta.percentage)];
      if (item.action === "commission.toggle") {
        bits.push(meta.isActive ? t.commissionActive : t.commissionInactive);
      }
      return bits.filter(Boolean).join(" · ");
    }
    case "partner.api_key":
      return partner;
    case "account.create":
    case "account.delete":
      return meta.email || "";
    case "product.update": {
      const name = tName(meta.name, lang) || meta.sku || "";
      const changes = (meta.changes || [])
        .map((change) => fieldLabel(t, change.field))
        .filter(Boolean);
      return [name, meta.sku, changes.join(", ")].filter(Boolean).join(" · ");
    }
    case "catalog.sync":
      return `${Number(meta.products || 0).toLocaleString("en-US")} ${t.products} · ${Number(meta.categories || 0).toLocaleString("en-US")} ${t.categoriesCount}`;
    case "category.update":
    case "category.image":
      return tName(meta.name, lang) || meta.categoryId || "";
    case "settings.update":
      return `${t.categoryLayout} · ${meta.categoryLayout || "—"}`;
    case "enquiry.create":
      return [meta.productName, meta.email, meta.subject].filter(Boolean).join(" · ");
    default:
      return "";
  }
}

export default function AdminActivity() {
  const { t, lang } = useLang();
  const [params, setParams] = useSearchParams();
  const group = params.get("group") || "";
  const page = Math.max(1, Number(params.get("page")) || 1);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api
      .adminActivity({ group, page, limit: 30 })
      .then(setData)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [group, page]);

  function setGroup(next) {
    const nextParams = new URLSearchParams(params);
    if (next) nextParams.set("group", next);
    else nextParams.delete("group");
    nextParams.delete("page");
    setParams(nextParams);
  }

  function goPage(next) {
    const nextParams = new URLSearchParams(params);
    if (next > 1) nextParams.set("page", String(next));
    else nextParams.delete("page");
    setParams(nextParams);
  }

  const activities = data?.activities || [];
  const pagination = data?.pagination || { page: 1, pages: 1, total: 0 };

  return (
    <div>
      <div className="mb-6">
        <h2 className="font-display text-3xl">{t.activity}</h2>
      </div>

      <div className="mb-8 flex flex-wrap gap-2">
        {GROUPS.map((item) => (
          <button
            key={item.id || "all"}
            type="button"
            onClick={() => setGroup(item.id)}
            className={`rounded-full px-4 py-2 text-xs font-semibold ${
              group === item.id ? "bg-brown text-cream" : "bg-white text-brown/70 ring-1 ring-brown/10"
            }`}
          >
            {t[item.key]}
          </button>
        ))}
      </div>

      {error ? <p className="mb-4 text-sm text-red-700">{error}</p> : null}

      {loading ? (
        <Spinner label={t.loading} />
      ) : activities.length ? (
        <div className="grid gap-3">
          {activities.map((item) => (
            <article
              key={item.id}
              className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-brown/5"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold tracking-[0.18em] text-tan uppercase">
                    {actionTitle(item, t)}
                  </p>
                  <p className="mt-2 font-medium leading-snug">
                    {activityDetail(item, t, lang) || "—"}
                  </p>
                  <p className="mt-2 break-all text-sm text-brown/50">
                    {item.actorEmail || t.activityUnknownActor}
                  </p>
                </div>
                <p className="shrink-0 text-xs text-brown/40" dir="ltr">
                  {formatWhen(item.createdAt, lang)}
                </p>
              </div>
              {item.action === "product.update" && item.meta?.changes?.length ? (
                <ul className="mt-3 space-y-1 text-xs text-brown/55">
                  {item.meta.changes.map((change) => (
                    <li key={`${item.id}-${change.field}`}>
                      {fieldLabel(t, change.field)}:{" "}
                      {formatValue(t, change.field, change.from, lang)} →{" "}
                      {formatValue(t, change.field, change.to, lang)}
                    </li>
                  ))}
                </ul>
              ) : null}
            </article>
          ))}
        </div>
      ) : (
        <p className="rounded-3xl bg-white px-6 py-12 text-center text-sm text-brown/45 shadow-sm ring-1 ring-brown/5">
          {t.activityEmpty}
        </p>
      )}

      {pagination.pages > 1 ? (
        <div className="mt-4 flex justify-center gap-2">
          {Array.from({ length: pagination.pages }, (_, i) => i + 1)
            .filter(
              (n) => n === 1 || n === pagination.pages || Math.abs(n - pagination.page) <= 2
            )
            .map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => goPage(n)}
                className={`h-9 min-w-9 rounded-full ${
                  n === pagination.page ? "bg-brown text-cream" : "bg-white"
                }`}
              >
                {n}
              </button>
            ))}
        </div>
      ) : null}
    </div>
  );
}
