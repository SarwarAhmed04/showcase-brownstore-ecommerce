/**
 * Local Elryan WIP host — keep untracked for GINI-only deploys.
 * Imported optionally from Commissions.jsx / PlatformSidebar.jsx.
 */
import ElryanDimensionsMapping from "./ElryanDimensionsMapping";
import ElryanApiConnection from "./ElryanApiConnection";
import ElryanAttributeMappings from "./ElryanAttributeMappings";
import ElryanWarrantyMapping from "./ElryanWarrantyMapping";
import ElryanSmartMapping from "./ElryanSmartMapping";
import ElryanPanelErrorBoundary from "./ElryanPanelErrorBoundary";
import ElryanSyncAll from "./ElryanSyncAll";
import ElryanSyncOneProduct from "./ElryanSyncOneProduct";
import {
  elryanPlatformSectionEntries,
  isElryanCategoryMappingTab,
} from "../../../utils/elryanCategoryMappingPage";

export function elryanPlatformSections() {
  return elryanPlatformSectionEntries();
}

export default function ElryanPlatformHost({ tab, partnerSlug, t, lang }) {
  if (partnerSlug !== "elryan") return null;

  if (tab === "connection") return <ElryanApiConnection t={t} />;
  if (isElryanCategoryMappingTab(tab)) {
    return (
      <ElryanPanelErrorBoundary t={t}>
        <ElryanSmartMapping t={t} lang={lang} />
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
  if (tab === "elryanWarrantyMapping") {
    return (
      <ElryanPanelErrorBoundary t={t}>
        <ElryanWarrantyMapping t={t} lang={lang} />
      </ElryanPanelErrorBoundary>
    );
  }
  if (tab === "elryanDimensionsMapping") {
    return (
      <ElryanPanelErrorBoundary t={t}>
        <ElryanDimensionsMapping t={t} lang={lang} />
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
  if (tab === "syncAll") {
    return (
      <ElryanPanelErrorBoundary t={t}>
        <ElryanSyncAll t={t} />
      </ElryanPanelErrorBoundary>
    );
  }
  return null;
}
