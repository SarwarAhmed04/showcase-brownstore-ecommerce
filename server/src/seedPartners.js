import { Commission } from "./models/Commission.js";
import { Partner, PARTNER_DEFS } from "./models/Partner.js";

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
}
