import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import CategoryTile from "./CategoryTile";
import Logo from "./Logo";
import { RailArrows, Reveal } from "./ui";
import { imgUrl } from "../lib/img";
import { useRail } from "../lib/hooks";

function CatImage({ src, className, w = 400, h = 400 }) {
  if (src) {
    return <img src={imgUrl(src, { w, h })} alt="" loading="lazy" decoding="async" className={className} />;
  }
  return (
    <span className={`grid place-items-center bg-bean-100 ${className}`}>
      <Logo className="h-8 w-8 opacity-40" />
    </span>
  );
}

const Forward = ({ className = "" }) => (
  <ArrowLeft className={`ltr:rotate-180 ${className}`} />
);

/* Arches: a scrolling rail on phones, a centred wrap from `sm` up. */
function Mosaic({ items }) {
  return (
    <div className="no-scrollbar -mx-4 flex gap-4 overflow-x-auto px-4 pb-2 sm:mx-0 sm:flex-wrap sm:justify-center sm:gap-x-6 sm:gap-y-12 sm:overflow-visible sm:px-0 sm:pb-0">
      {items.map((cat, n) => (
        <Reveal
          key={cat.slug}
          delay={(n % 5) * 60}
          className="w-[40vw] max-w-[200px] shrink-0 sm:w-[calc(33.333%-1rem)] sm:max-w-none lg:w-[calc(20%-1.2rem)]"
        >
          <CategoryTile category={cat} />
        </Reveal>
      ))}
    </div>
  );
}

function Circles({ items }) {
  return (
    <div className="grid grid-cols-3 gap-x-3 gap-y-8 sm:grid-cols-5 lg:grid-cols-9">
      {items.map((cat) => (
        <Link key={cat.slug} to={`/category/${cat.slug}`} className="group flex flex-col items-center gap-3 text-center">
          <span className="relative block aspect-square w-full max-w-32 overflow-hidden rounded-full bg-bean-100 outline outline-1 outline-offset-4 outline-bean-900/15 transition-[outline-color] duration-300 group-hover:outline-primary">
            <CatImage src={cat.cover} className="absolute inset-0 h-full w-full object-cover transition-transform duration-700 group-hover:scale-110" />
          </span>
          <span className="max-w-32 text-sm font-semibold leading-snug text-bean-900 transition-colors group-hover:text-primary">
            {cat.name}
          </span>
        </Link>
      ))}
    </div>
  );
}

function Cards({ items }) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 md:grid-cols-4">
      {items.map((cat) => (
        <Link key={cat.slug} to={`/category/${cat.slug}`} className="group block">
          <span className="block aspect-[4/3] overflow-hidden rounded-lg bg-bean-100">
            <CatImage
              src={cat.cover}
              w={600}
              h={450}
              className="h-full w-full object-cover transition-transform duration-700 group-hover:scale-105"
            />
          </span>
          <span className="mt-3 flex items-center justify-between gap-3 border-b border-bean-900/15 pb-3">
            <span className="text-sm font-semibold text-bean-900 transition-colors group-hover:text-primary sm:text-base">
              {cat.name}
            </span>
            <Forward className="size-4 shrink-0 text-bean-900/35 transition-colors group-hover:text-primary" />
          </span>
        </Link>
      ))}
    </div>
  );
}

function Posters({ items }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((cat) => (
        <Link
          key={cat.slug}
          to={`/category/${cat.slug}`}
          className="group relative block aspect-[4/3] overflow-hidden rounded-lg bg-bean-900 lg:aspect-[4/5]"
        >
          <CatImage
            src={cat.cover}
            w={800}
            h={1000}
            className="absolute inset-0 h-full w-full object-cover opacity-90 transition-transform duration-700 group-hover:scale-105"
          />
          <span className="absolute inset-0 bg-gradient-to-t from-bean-900/85 via-bean-900/10 to-transparent" />
          <span className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-4 p-5 sm:p-6">
            <span className="sf-display text-2xl text-bean-50 sm:text-3xl">{cat.name}</span>
            <span className="grid size-11 shrink-0 place-items-center rounded-full bg-bean-50 text-bean-900 transition-colors duration-300 group-hover:bg-tan">
              <Forward className="size-4" />
            </span>
          </span>
        </Link>
      ))}
    </div>
  );
}

function Index({ items }) {
  return (
    <ol className="grid gap-x-12 border-t border-bean-900/15 md:grid-cols-2">
      {items.map((cat, index) => (
        <li key={cat.slug}>
          <Link to={`/category/${cat.slug}`} className="group flex items-center gap-4 border-b border-bean-900/15 py-4">
            <span dir="ltr" className="w-7 shrink-0 font-display text-sm font-bold tabular-nums text-primary">
              {String(index + 1).padStart(2, "0")}
            </span>
            <span className="h-14 w-11 shrink-0 overflow-hidden rounded-t-full bg-bean-100">
              <CatImage src={cat.cover} w={120} h={150} className="h-full w-full object-cover" />
            </span>
            <span className="min-w-0 flex-1 truncate font-display text-lg font-bold text-bean-900 transition-colors group-hover:text-primary">
              {cat.name}
            </span>
            <Forward className="size-4 shrink-0 text-bean-900/30 transition-all duration-300 group-hover:text-primary ltr:group-hover:translate-x-1 rtl:group-hover:-translate-x-1" />
          </Link>
        </li>
      ))}
    </ol>
  );
}

function Pills({ items }) {
  const rail = useRail(items.length);
  return (
    <div className="flex items-center gap-4">
      <div ref={rail.ref} className="no-scrollbar flex min-w-0 flex-1 gap-2.5 overflow-x-auto">
        {items.map((cat) => (
          <Link
            key={cat.slug}
            to={`/category/${cat.slug}`}
            className="flex shrink-0 items-center gap-2.5 rounded-full border border-bean-900/15 bg-card py-1.5 pe-4 ps-1.5 text-sm font-semibold text-bean-900 transition-colors duration-300 hover:border-bean-900 hover:bg-bean-900 hover:text-bean-50"
          >
            <span className="size-9 shrink-0 overflow-hidden rounded-full bg-bean-100">
              <CatImage src={cat.cover} w={80} h={80} className="h-full w-full object-cover" />
            </span>
            {cat.name}
          </Link>
        ))}
      </div>
      <RailArrows rail={rail} />
    </div>
  );
}

const LAYOUTS = { mosaic: Mosaic, circles: Circles, cards: Cards, posters: Posters, rail: Index, pills: Pills };

/** Home-page departments, in whichever layout the admin picked. */
export default function CategoryShowcase({ categories, layout = "mosaic" }) {
  if (!categories?.length) return null;
  const Layout = LAYOUTS[layout] || Mosaic;
  return <Layout items={categories} />;
}
