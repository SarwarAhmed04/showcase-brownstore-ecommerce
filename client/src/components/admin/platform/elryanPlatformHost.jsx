/**
 * Local Elryan WIP host — keep untracked for GINI-only deploys.
 * Imported optionally from Commissions.jsx / PlatformSidebar.jsx.
 */
import ElryanApiConnection from "./ElryanApiConnection";
import ElryanAttributeMappings from "./ElryanAttributeMappings";
import ElryanCatalogBrowse from "./ElryanCatalogBrowse";
import ElryanSmartMapping from "./ElryanSmartMapping";
import ElryanPanelErrorBoundary from "./ElryanPanelErrorBoundary";
import ElryanSyncOneProduct from "./ElryanSyncOneProduct";

export function elryanPlatformSections() {
  return [
    ["connection", "elryanApiConnection"],
    ["elryanCategories", "elryanCategoriesTitle"],
    ["elryanSmartMapping", "elryanSmartMappingTitle"],
    ["elryanAttributes", "elryanAttributesTitle"],
    ["syncOne", "elryanSyncOneTitle"],
  ];
}

export default function ElryanPlatformHost({ tab, partnerSlug, t, lang }) {
  if (partnerSlug !== "elryan") return null;

  if (tab === "connection") return <ElryanApiConnection t={t} />;
  if (tab === "elryanCategories") {
    return (
      <ElryanPanelErrorBoundary t={t}>
        <ElryanCatalogBrowse t={t} />
      </ElryanPanelErrorBoundary>
    );
  }
  if (tab === "elryanSmartMapping") {
    return (
      <ElryanPanelErrorBoundary t={t}>
        <ElryanSmartMapping t={t} />
      </ElryanPanelErrorBoundary>
    );
  }
  if (tab === "elryanAttributes") {
    return (
      <ElryanPanelErrorBoundary t={t}>
        <ElryanAttributeMappings t={t} />
      </ElryanPanelErrorBoundary>
    );
  }
  if (tab === "syncOne") {
    return (
      <ElryanPanelErrorBoundary t={t}>
        <ElryanSyncOneProduct t={t} lang={lang} />
      </ElryanPanelErrorBoundary>
    );
  }
  return null;
}
