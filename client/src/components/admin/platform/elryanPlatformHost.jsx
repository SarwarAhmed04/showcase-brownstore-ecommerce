/**
 * Elryan admin panels, code-split from the main admin bundle.
 * Commissions.jsx and PlatformSidebar.jsx load this file with a static
 * dynamic import. Do not mark that import @vite-ignore: Vite must bundle it.
 * GINI and Miswag never render this host.
 */
import ElryanDimensionsMapping from "./ElryanDimensionsMapping";
import ElryanApiConnection from "./ElryanApiConnection";
import ElryanValueMapping from "./ElryanValueMapping";
import ElryanWarrantyMapping from "./ElryanWarrantyMapping";
import ElryanSmartMapping from "./ElryanSmartMapping";
import ElryanPanelErrorBoundary from "./ElryanPanelErrorBoundary";
import ElryanSyncAll from "./ElryanSyncAll";
import ElryanSyncOneProduct from "./ElryanSyncOneProduct";
import {
  elryanPlatformSectionEntries,
  isElryanCategoryMappingTab,
} from "../../../utils/elryanCategoryMappingPage";
import {
  ELRYAN_BRAND_MAPPING_TAB,
  ELRYAN_COLOUR_MAPPING_TAB,
  ELRYAN_LEGACY_VALUE_MAPPING_TAB,
} from "../../../utils/elryanValueMappingPage";

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
  if (tab === ELRYAN_BRAND_MAPPING_TAB || tab === ELRYAN_LEGACY_VALUE_MAPPING_TAB) {
    return (
      <ElryanPanelErrorBoundary t={t}>
        <ElryanValueMapping t={t} kind="brand" />
      </ElryanPanelErrorBoundary>
    );
  }
  if (tab === ELRYAN_COLOUR_MAPPING_TAB) {
    return (
      <ElryanPanelErrorBoundary t={t}>
        <ElryanValueMapping t={t} kind="color" />
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
