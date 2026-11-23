import { Activity } from "./models/Activity.js";
import { Commission } from "./models/Commission.js";
import { Partner, PARTNER_DEFS } from "./models/Partner.js";
import { PlatformProduct } from "./models/PlatformProduct.js";
import { PlatformTaxonomyConfig } from "./models/PlatformTaxonomyConfig.js";
import { PlatformTaxonomyNotice } from "./models/PlatformTaxonomyNotice.js";
import { PlatformVisibilityRule } from "./models/PlatformVisibilityRule.js";
import { removeLocalPartnerImage } from "./utils/categoryView.js";

const REMOVED_PARTNER_SLUG = "ibazzar";

async function removeRetiredPartner() {
  const existing = await Partner.findOne({ slug: REMOVED_PARTNER_SLUG }).select("image").lean();
  if (existing?.image) removeLocalPartnerImage(existing.image);
  await Promise.all([
    Partner.deleteMany({ slug: REMOVED_PARTNER_SLUG }),
    Commission.deleteMany({ partner: REMOVED_PARTNER_SLUG }),
    PlatformProduct.deleteMany({ partner: REMOVED_PARTNER_SLUG }),
    PlatformTaxonomyConfig.deleteMany({ partner: REMOVED_PARTNER_SLUG }),
    PlatformTaxonomyNotice.deleteMany({ partner: REMOVED_PARTNER_SLUG }),
    PlatformVisibilityRule.deleteMany({ partner: REMOVED_PARTNER_SLUG }),
    Activity.deleteMany({ "meta.partner": REMOVED_PARTNER_SLUG }),
  ]);
}

async function dropLegacyCommissionIndex() {
  try {
    const indexes = await Commission.collection.indexes();
    for (const idx of indexes) {
      if (!idx.unique || idx.name === "_id_" || idx.name === "partner_1_scope_1_targetId_1") {
        continue;
      }
      await Commission.collection.dropIndex(idx.name).catch(() => {});
    }
  } catch {
    // Collection or indexes may not exist yet.
  }
}

export async function seedPartners() {
  await removeRetiredPartner();
  await dropLegacyCommissionIndex();
  await Commission.deleteMany({
    $or: [{ partner: { $exists: false } }, { partner: null }, { partner: "" }],
  });

  for (const def of PARTNER_DEFS) {
    const existing = await Partner.findOne({ slug: def.slug });
    if (existing) {
      if (!existing.image && def.image) {
        existing.image = def.image;
        await existing.save();
      }
      continue;
    }
    await Partner.create({
      slug: def.slug,
      name: def.name,
      image: def.image || "",
      apiKeyHash: "",
      apiKeyPrefix: "",
      isActive: true,
    });
    console.log(`Seeded partner store: ${def.name}`);
  }

  const fixed = new Set(PARTNER_DEFS.map((item) => item.slug));
  const unknown = await Partner.find({ slug: { $nin: [...fixed] } }).select("slug name").lean();
  if (unknown.length) {
    console.log(
      `Unregistered platforms kept (not deleted): ${unknown
        .map((item) => `${item.slug} (${item.name})`)
        .join(", ")}`
    );
  }
}
