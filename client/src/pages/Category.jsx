import { Link, Navigate, useParams } from "react-router-dom";
import Catalog from "../components/Catalog";
import { Breadcrumbs } from "../components/PageHead";
import { PageSkeleton } from "../components/ui";
import { useCatalog } from "../lib/catalogStore";
import { imgUrl } from "../lib/img";
import { categoryIcon } from "../lib/icons";
import { useLang } from "../context/LangContext";

export default function Category() {
  const { slug } = useParams();
  const { categories, categoryBySlug, status } = useCatalog();
  const { t } = useLang();
  const cat = categoryBySlug[slug];

  if (status === "loading") return <PageSkeleton />;
  if (!cat) return <Navigate to="/404" replace />;

  const others = categories.filter((c) => c.slug !== slug);

  return (
    <>
      <section className="relative overflow-hidden bg-bean-900 text-bean-50">
        <div className="container-x relative grid items-end gap-10 py-12 sm:py-16 lg:grid-cols-[1.1fr_.7fr] lg:py-20">
          <div>
            <Breadcrumbs
              crumbs={[{ label: t.shop, to: "/shop" }, { label: cat.name }]}
              className="text-bean-50/55"
            />
            <p className="sf-eyebrow mt-8 text-tan">{t.shop}</p>
            <h1 className="sf-display mt-4 text-4xl sm:text-5xl lg:text-6xl">{cat.name}</h1>
            {cat.tagline ? (
              <p className="mt-4 max-w-md text-sm leading-relaxed text-bean-50/65 sm:text-base">{cat.tagline}</p>
            ) : null}
          </div>

          <div className="relative mx-auto hidden w-full max-w-[260px] lg:block">
            <div aria-hidden className="absolute -inset-3 rounded-t-full border border-tan/25" />
            <div className="aspect-[3/4] overflow-hidden rounded-t-full bg-bean-800">
              {cat.cover ? (
                <img
                  src={imgUrl(cat.cover, { w: 600, h: 800 })}
                  alt=""
                  className="h-full w-full object-cover"
                />
              ) : null}
            </div>
          </div>
        </div>
      </section>

      {others.length > 0 && (
        <div className="border-b border-bean-900/10">
          <div className="container-x no-scrollbar flex gap-1 overflow-x-auto py-3">
            {others.map((c) => (
              <Link
                key={c.slug}
                to={`/category/${c.slug}`}
                className="shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold text-bean-900/60 transition-colors hover:bg-bean-100 hover:text-bean-900"
              >
                {c.name}
              </Link>
            ))}
          </div>
        </div>
      )}

      <div className="container-x py-10 lg:py-14">
        <Catalog
          query={{ category: slug }}
          lockCategory
          emptyIcon={categoryIcon(cat.icon)}
          emptyTitle={t.nothingMatches}
          emptySub={t.widenFilters}
        />
      </div>
    </>
  );
}
