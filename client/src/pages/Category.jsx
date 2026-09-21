import { Link, Navigate, useParams } from "react-router-dom";
import Catalog from "../components/Catalog";
import PageHead from "../components/PageHead";
import { PageSkeleton } from "../components/ui";
import { useCatalog } from "../lib/catalogStore";
import { imgUrl } from "../lib/img";
import { CategoryIcon, categoryIcon } from "../lib/icons";
import { useLang } from "../context/LangContext";

export default function Category() {
  const { slug } = useParams();
  const { categories, categoryBySlug, status } = useCatalog();
  const { t } = useLang();
  const cat = categoryBySlug[slug];

  if (status === "loading") return <PageSkeleton />;
  if (!cat) return <Navigate to="/404" replace />;

  return (
    <div className="container-x py-10 lg:py-14">
      <div className="glass relative mb-9 overflow-hidden rounded-panel">
        <img
          src={imgUrl(cat.cover, { w: 1600, h: 500 })}
          alt=""
          className="absolute inset-0 h-full w-full object-cover opacity-25"
        />
        <div
          className="absolute inset-0"
          style={{
            background: `linear-gradient(100deg, rgb(var(--bg)) 20%, rgb(var(--bg) / .7) 55%, rgb(${cat.tone} / .2))`,
          }}
        />
        <div className="relative p-8 sm:p-12">
          <PageHead
            eyebrow={
              <>
                <CategoryIcon name={cat.icon} size={12} /> {t.shop}
              </>
            }
            title={cat.name}
            sub={cat.tagline}
            crumbs={[{ label: t.shop, to: "/shop" }, { label: cat.name }]}
          />

          <div className="no-bar -mb-1 flex gap-1.5 overflow-x-auto pb-1">
            {categories
              .filter((c) => c.slug !== slug)
              .map((c) => (
                <Link
                  key={c.slug}
                  to={`/category/${c.slug}`}
                  className="glass-soft whitespace-nowrap rounded-full px-3.5 py-1.5 text-xs font-medium transition hover:text-primary"
                >
                  {c.name}
                </Link>
              ))}
          </div>
        </div>
      </div>

      <Catalog
        query={{ category: slug }}
        lockCategory
        emptyIcon={categoryIcon(cat.icon)}
        emptyTitle={t.nothingMatches}
        emptySub={t.widenFilters}
      />
    </div>
  );
}
