import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Commission } from "./models/Commission.js";
import { Partner } from "./models/Partner.js";
import { Product } from "./models/Product.js";
import { ElryanConnection } from "./models/ElryanConnection.js";
import { ElryanValueMapping } from "./models/ElryanValueMapping.js";
import { ElryanConfirmedSend } from "./models/ElryanConfirmedSend.js";
import { ElryanSendAttempt } from "./models/ElryanSendAttempt.js";
import { ElryanSyncOnePreview } from "./models/ElryanSyncOnePreview.js";
import { ElryanStagingProductOverride } from "./models/ElryanStagingProductOverride.js";
import { ElryanStagingPriceApproval } from "./models/ElryanStagingPriceApproval.js";
import { ElryanStagingDimensionCheck } from "./models/ElryanStagingDimensionCheck.js";
import { PlatformTaxonomyConfig } from "./models/PlatformTaxonomyConfig.js";
import { encryptApiKey } from "./utils/partnerAuth.js";
import { applyCommissionRate } from "./utils/commission.js";
import { ELRYAN_READINESS } from "./utils/elryanConstants.js";
import { buildElryanPricingView, elryanOutboundPriceHash } from "./utils/elryanPricing.js";
import { collectElryanImageUrls, setElryanMediaFetchForTests } from "./utils/elryanImages.js";
import { publicMediaUrl } from "./utils/commissionExcel.js";
import { validateElryanPreviewParts } from "./utils/elryanValidator.js";
import {
  matchElryanStagingPriceApproval,
  mergeElryanStagingAttributes,
} from "./utils/elryanStagingGate.js";
import { setElryanFetch } from "./services/elryanClient.js";
import {
  confirmElryanStagingDimensions,
  saveElryanStagingProductOverride,
} from "./services/elryanStagingInput.js";
import {
  approveElryanStagingPrice,
  previewElryanSyncOne,
  sendElryanSyncOne,
} from "./services/elryanSyncOne.js";

process.env.JWT_SECRET = process.env.JWT_SECRET || "elryan-sync-one-test-secret";
delete process.env.ELRYAN_PRODUCT_WRITES_ENABLED;
delete process.env.ELRYAN_ALLOW_LIVE_PRODUCT_WRITES;

const API_KEY = "elryan-test-key-not-for-browser-9f3c";

function mockResponse(status, body = {}) {
  const text = JSON.stringify(body);
  return {
    status,
    headers: { get: () => "application/json" },
    async text() {
      return text;
    },
  };
}

describe("Elryan staging create gates", () => {
  it("resolves an Elryan commission rule and ignores other partners", async () => {
    const product = { _id: "p", price: 10000, brand: { _id: "brand-1" } };
    const ignored = await buildElryanPricingView(product, {
      commissionRules: [
        { partner: "miswag", scope: "all", targetId: "*", percentage: 50, isActive: true },
        { partner: "gini", scope: "brand", targetId: "brand-1", percentage: 25, isActive: true },
        { partner: "elryan", scope: "all", targetId: "*", percentage: 40, isActive: false },
      ],
    });
    assert.equal(ignored.storeSellingPrice, 10000);
    assert.equal(ignored.commissionRate, 0);
    assert.equal(ignored.proposedElryanPrice, 10000);
    assert.equal(ignored.proposedElryanCost, null);
    assert.equal(ignored.pricingSource.applied, null);

    const branded = await buildElryanPricingView(product, {
      commissionRules: [
        { partner: "miswag", scope: "all", targetId: "*", percentage: 50, isActive: true, _id: "m1" },
        { partner: "elryan", scope: "all", targetId: "*", percentage: 3, isActive: true, _id: "e-all" },
        {
          partner: "elryan",
          scope: "brand",
          targetId: "brand-1",
          percentage: 10,
          isActive: true,
          _id: "e-brand",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    assert.equal(branded.commissionScope, "brand");
    assert.equal(branded.commissionRate, 10);
    assert.equal(branded.proposedElryanPrice, applyCommissionRate(10000, 10));
    assert.equal(branded.proposedElryanCost, null);

    const rounded = await buildElryanPricingView({ _id: "p2", price: 10001 }, { commissionRules: [] });
    assert.equal(rounded.storeSellingPrice, 10001);
    assert.equal(rounded.proposedElryanPrice, applyCommissionRate(10001, 0));

    const edited = await buildElryanPricingView(product, {
      commissionRules: [
        {
          partner: "elryan",
          scope: "brand",
          targetId: "brand-1",
          percentage: 10,
          isActive: true,
          _id: "e-brand",
          updatedAt: "2026-03-01T00:00:00.000Z",
        },
      ],
    });
    assert.equal(edited.proposedElryanPrice, branded.proposedElryanPrice);
    assert.notEqual(
      elryanOutboundPriceHash({ price: edited.proposedElryanPrice }, edited.pricingSource),
      elryanOutboundPriceHash({ price: branded.proposedElryanPrice }, branded.pricingSource)
    );

    const ambiguous = await buildElryanPricingView(
      { _id: "p3", price: { amount: 10 } },
      { commissionRules: [{ partner: "elryan", scope: "all", targetId: "*", percentage: 10, isActive: true }] }
    );
    assert.equal(ambiguous.proposedElryanPrice, null);
    assert.equal(ambiguous.priceReview, true);

    const base = {
      hasApiKey: true,
      resolved: { name: { en: "A", ar: "ب" } },
      sku: "OWCH180002",
      mapping: { categoryId: "340" },
      brand: { elryanId: "276" },
      color: { elryanId: "59" },
      warranty: { elryanCode: "rlbo35igt4" },
      warrantyCatalog: { checked: true, codes: ["rlbo35igt4"], empty: false, message: "" },
      attributes: { chopper_power: 6150 },
      requiredAttributeCodes: ["chopper_power"],
      variation: { ok: true, reasons: [] },
      pricing: branded,
      images: ["https://cdn.example.com/chopper.jpg"],
    };
    const ready = validateElryanPreviewParts(base);
    assert.equal(ready.ready, true);
    assert.equal(ready.blockers.some((blocker) => blocker.code === "pricing_unverified"), false);
    const blocked = validateElryanPreviewParts({ ...base, pricing: ambiguous });
    assert.equal(blocked.ready, false);
    assert.equal(blocked.blockers.some((blocker) => blocker.code === "price_needs_review"), true);
  });

  it("does not treat a staging override or a mismatched approval as production-ready", () => {
    const merged = mergeElryanStagingAttributes("production", {}, {
      environment: "staging",
      attributes: { chopper_power: 6150 },
    });
    assert.equal(merged.chopper_power, undefined);

    const mismatch = matchElryanStagingPriceApproval(
      {
        environment: "staging",
        productId: "p1",
        sku: "OWCH180002",
        price: 66250,
        currency: "IQD",
        commissionRate: 14,
        sendPriceOnly: true,
        costOmitted: true,
        payoutUnknownAccepted: true,
        payloadHash: "old",
      },
      {
        environment: "staging",
        productId: "p1",
        sku: "OWCH180002",
        payload: { price: 66250 },
        payloadHash: "new",
        liveCommission: 14,
      }
    );
    assert.equal(mismatch.valid, false);
    assert.equal(mismatch.reason, "payload_mismatch");
  });
});

describe("Elryan single-product staging create", { concurrency: 1 }, () => {
  let memory;
  let productId;
  let otherId;
  let mode;
  let posts;
  let skuReads;
  let createdBody;
  let releaseHang;

  function enableWrites() {
    process.env.ELRYAN_PRODUCT_WRITES_ENABLED = "true";
    process.env.ELRYAN_ALLOW_LIVE_PRODUCT_WRITES = "true";
  }

  function installFetch() {
    setElryanFetch(async (url, options = {}) => {
      const method = String(options.method || "GET").toUpperCase();
      const target = String(url);
      if (target.includes("/sku-exists")) {
        skuReads += 1;
        if (mode === "sku-taken" || (mode === "throw-taken" && skuReads > 1)) {
          return mockResponse(409, { success: false, error: { code: "CONFLICT", message: "SKU already used" } });
        }
        return mockResponse(200, { success: true, data: { available: true } });
      }
      if (method === "POST" && target.includes("/v1/products")) {
        posts += 1;
        createdBody = JSON.parse(options.body || "{}");
        if (mode === "reject") return mockResponse(422, { message: "attribute invalid" });
        if (mode === "throw" || mode === "throw-taken") throw new Error("socket hang up");
        if (mode === "hang") await releaseHang;
        if (mode === "published") {
          return mockResponse(201, { data: { id: "elr-99", status: "published" } });
        }
        return mockResponse(201, { data: { id: "elr-99", status: "in_review" } });
      }
      if (target.includes("/v1/warranty")) {
        return mockResponse(200, { data: [{ warranty_code: "rlbo35igt4", warranty_name: "waranty kenwood" }] });
      }
      if (target.includes("/attribute-sets/")) {
        return mockResponse(200, {
          data: {
            id: "67",
            attributes: [
              {
                code: "chopper_power",
                mandatory: true,
                values: [{ id: 6150, name: "0 - 400 W" }],
              },
            ],
          },
        });
      }
      if (target.includes("/commissions/calculate")) {
        return mockResponse(200, {
          data: { type: "category", commission: mode === "commission-15" ? 15 : 14 },
        });
      }
      if (method !== "GET" && method !== "HEAD") {
        throw new Error(`Unexpected write ${method} ${target}`);
      }
      return mockResponse(200, { data: { ok: true } });
    });
  }

  async function makeReady() {
    await saveElryanStagingProductOverride({
      environment: "staging",
      productId,
      sku: "OWCH180002",
      attributes: { chopper_power: 6150 },
      confirm: true,
    });
    await confirmElryanStagingDimensions({
      environment: "staging",
      productId,
      sku: "OWCH180002",
      unit: "cm",
      width: 30,
      height: 40,
      depth: 20,
      axesConfirmed: true,
      confirm: true,
    });
    await approveElryanStagingPrice({ productId, confirm: true });
  }

  before(async () => {
    memory = await MongoMemoryServer.create();
    await mongoose.connect(memory.getUri("elryan-sync-one-create"));
    await Partner.create({ slug: "elryan", name: "Elryan", isActive: true });
  });

  after(async () => {
    delete process.env.ELRYAN_PRODUCT_WRITES_ENABLED;
    delete process.env.ELRYAN_ALLOW_LIVE_PRODUCT_WRITES;
    setElryanMediaFetchForTests(null);
    setElryanFetch(null);
    await mongoose.disconnect();
    await memory.stop();
  });

  beforeEach(async () => {
    mode = "ok";
    posts = 0;
    skuReads = 0;
    createdBody = null;
    releaseHang = Promise.resolve();
    delete process.env.ELRYAN_PRODUCT_WRITES_ENABLED;
    delete process.env.ELRYAN_ALLOW_LIVE_PRODUCT_WRITES;
    setElryanMediaFetchForTests(null);
    installFetch();
    await Promise.all([
      Product.deleteMany({}),
      ElryanConnection.deleteMany({}),
      ElryanValueMapping.deleteMany({}),
      PlatformTaxonomyConfig.deleteMany({ partner: "elryan" }),
      ElryanStagingProductOverride.deleteMany({}),
      ElryanStagingPriceApproval.deleteMany({}),
      ElryanStagingDimensionCheck.deleteMany({}),
      ElryanSendAttempt.deleteMany({}),
      ElryanConfirmedSend.deleteMany({}),
      ElryanSyncOnePreview.deleteMany({}),
    ]);
    const product = await Product.create({
      ibsherId: "ibs-chopper",
      itemCode: "OWCH180002",
      name: { en: "Kenwood Food Chopper", ar: "قطاعة" },
      description: { en: "Chopper" },
      price: 66250,
      brand: { _id: "kenwood-brand", name: "Kenwood" },
      collectionName: { _id: "choppers", name: { en: "Choppers" } },
      variants: [
        {
          color: { en: "White" },
          images: [{ url: "https://cdn.example.com/chopper.jpg", isMain: true }],
          sizes: [{ size: "One", stockQuantity: 3 }],
        },
      ],
      isActive: true,
    });
    productId = String(product._id);
    const other = await Product.create({
      ibsherId: "ibs-other",
      itemCode: "OTHER-1",
      name: { en: "Other Chopper", ar: "أخرى" },
      description: { en: "Other" },
      price: 66250,
      brand: { _id: "kenwood-brand", name: "Kenwood" },
      collectionName: { _id: "choppers", name: { en: "Choppers" } },
      variants: [
        {
          color: { en: "White" },
          images: [{ url: "https://cdn.example.com/other.jpg", isMain: true }],
          sizes: [{ size: "One", stockQuantity: 1 }],
        },
      ],
      isActive: true,
    });
    otherId = String(other._id);
    await ElryanConnection.create({
      singletonKey: "default",
      environment: "staging",
      stagingApiKeyEnc: encryptApiKey(API_KEY),
      hasApiKey: true,
      lastStatus: "authenticated",
      lastAuthOk: true,
    });
    await PlatformTaxonomyConfig.create({
      partner: "elryan",
      brownCollectionId: "choppers",
      values: { categoryId: "340", categoryName: "Chopper", attributeSetId: "67" },
    });
    await ElryanValueMapping.create([
      {
        kind: "brand",
        brownKey: "staging:kenwood-brand",
        environment: "staging",
        elryanId: "276",
        elryanLabel: "Kenwood",
      },
      {
        kind: "color",
        brownKey: "staging:white",
        environment: "staging",
        elryanId: "59",
        elryanLabel: "White",
      },
      {
        kind: "warranty",
        brownKey: "staging:brand:kenwood-brand",
        environment: "staging",
        warrantyScope: "brand",
        elryanCode: "rlbo35igt4",
        elryanLabel: "waranty kenwood",
      },
    ]);
  });

  it("stores a staging override for one product and leaves the catalog product unchanged", async () => {
    const before = await Product.findById(productId).lean();
    const saved = await saveElryanStagingProductOverride({
      environment: "staging",
      productId,
      sku: "OWCH180002",
      attributes: { chopper_power: 6150 },
      confirm: true,
    });
    assert.equal(saved.attributes.chopper_power, 6150);
    const after = await Product.findById(productId).lean();
    assert.equal(String(before.updatedAt), String(after.updatedAt));
    assert.equal(after.price, 66250);
    await assert.rejects(
      () =>
        saveElryanStagingProductOverride({
          environment: "production",
          productId,
          sku: "OWCH180002",
          attributes: { chopper_power: 6150 },
          confirm: true,
        }),
      (err) => err.code === "staging_only"
    );

    const preview = await previewElryanSyncOne({ productId });
    const other = await previewElryanSyncOne({ productId: otherId });
    assert.equal(preview.stagingOverride.attributes.chopper_power, 6150);
    assert.equal(preview.proposedPayload.attributes.chopper_power, 6150);
    assert.equal(other.stagingOverride, null);
    assert.equal(other.proposedPayload.attributes, undefined);
    assert.equal(other.blockers.some((blocker) => blocker.code === "missing_attribute_chopper_power"), true);
    assert.equal(preview.blockers.some((blocker) => blocker.code === "dimensions_unverified"), true);
    assert.equal(preview.blockers.some((blocker) => blocker.code === "pricing_unverified"), false);
    assert.notEqual(preview.readiness, ELRYAN_READINESS.READY);
    assert.equal(posts, 0);
  });

  it("rejects dimension confirmation until the unit and axes are explicit", async () => {
    await assert.rejects(
      () =>
        confirmElryanStagingDimensions({
          environment: "staging",
          productId,
          sku: "OWCH180002",
          unit: "",
          width: 30,
          height: 40,
          depth: 20,
          axesConfirmed: true,
          confirm: true,
        }),
      (err) => err.code === "dimensions_unverified"
    );
    await assert.rejects(
      () =>
        confirmElryanStagingDimensions({
          environment: "staging",
          productId,
          sku: "OWCH180002",
          unit: "cm",
          width: 30,
          height: 40,
          depth: 20,
          axesConfirmed: false,
          confirm: true,
        }),
      (err) => err.code === "dimensions_unverified"
    );
    assert.equal(await ElryanStagingDimensionCheck.countDocuments({}), 0);
    assert.equal(posts, 0);
  });

  it("invalidates preview tokens when the payload or Elryan commission rules change", async () => {
    await saveElryanStagingProductOverride({
      environment: "staging",
      productId,
      sku: "OWCH180002",
      attributes: { chopper_power: 6150 },
      confirm: true,
    });
    await assert.rejects(
      () => approveElryanStagingPrice({ productId, confirm: true }),
      (err) => err.code === "not_ready"
    );
    assert.equal(await ElryanStagingPriceApproval.countDocuments({}), 0);

    try {
      await makeReady();
      const first = await previewElryanSyncOne({ productId });
      assert.equal(first.readiness, ELRYAN_READINESS.READY);
      assert.equal(first.proposedPayload.price, 66250);
      assert.equal("cost" in first.proposedPayload, false);
      assert.equal(first.proposedPayload.pricingSource, undefined);

      await ElryanStagingDimensionCheck.updateOne({ productId }, { $set: { depth: 21 } });
      const changed = await previewElryanSyncOne({ productId });
      assert.equal(changed.pricingApproval.valid, false);
      assert.equal(changed.pricingApproval.reason, "payload_mismatch");
      assert.equal(changed.blockers.some((blocker) => blocker.code === "pricing_unverified"), false);
      assert.equal(changed.readiness, ELRYAN_READINESS.READY);
      enableWrites();
      const stale = await sendElryanSyncOne({
        productId,
        confirm: true,
        previewToken: first.previewToken,
      });
      assert.equal(stale.code, "preview_mismatch");

      await ElryanStagingDimensionCheck.updateOne({ productId }, { $set: { depth: 20 } });
      await Commission.create({
        partner: "elryan",
        scope: "all",
        targetId: "*",
        percentage: 10,
        isActive: true,
      });
      const marked = await previewElryanSyncOne({ productId });
      assert.equal(marked.proposedPayload.price, applyCommissionRate(66250, 10));
      assert.equal(marked.pricing.commissionRate, 10);
      assert.equal(marked.blockers.some((blocker) => blocker.code === "pricing_unverified"), false);
      const staleAfterRule = await sendElryanSyncOne({
        productId,
        confirm: true,
        previewToken: first.previewToken,
      });
      assert.equal(staleAfterRule.code, "preview_mismatch");

      await Commission.create({
        partner: "miswag",
        scope: "all",
        targetId: "*",
        percentage: 80,
        isActive: true,
      });
      mode = "commission-15";
      const ignored = await previewElryanSyncOne({ productId });
      assert.equal(ignored.proposedPayload.price, applyCommissionRate(66250, 10));
      assert.equal(ignored.pricing.commissionRate, 10);

      await Commission.deleteMany({ partner: "elryan" });
      const restored = await previewElryanSyncOne({ productId });
      assert.equal(restored.proposedPayload.price, 66250);
      assert.equal(restored.pricing.commissionRate, 0);
      assert.equal(posts, 0);
    } finally {
      await Commission.deleteMany({ partner: { $in: ["elryan", "miswag"] } });
      delete process.env.ELRYAN_PRODUCT_WRITES_ENABLED;
      delete process.env.ELRYAN_ALLOW_LIVE_PRODUCT_WRITES;
    }
  });

  it("uses the public media URL for a relative image and invalidates the old preview token", async () => {
    const relative = "/uploads/products/chopper.webp";
    const expected = publicMediaUrl(relative);
    const webp = Buffer.concat([
      Buffer.from("RIFF"),
      Buffer.from([8, 0, 0, 0]),
      Buffer.from("WEBP"),
      Buffer.from("VP8 "),
    ]);
    const imageResponse = (status, type, body) => ({
      status,
      headers: { get: (name) => (String(name).toLowerCase() === "content-type" ? type : null) },
      async arrayBuffer() {
        return body;
      },
    });
    setElryanMediaFetchForTests(async () => imageResponse(200, "image/webp", webp));
    try {
      await Product.updateOne({ _id: productId }, { $set: { "variants.0.images.0.url": relative } });
      await makeReady();
      const preview = await previewElryanSyncOne({ productId, origin: "http://localhost:5173" });
      assert.equal(preview.proposedPayload.images[0].fileUrl, expected);
      assert.equal(preview.proposedPayload.images[0].fileUrl, collectElryanImageUrls({
        variants: [{ images: [{ url: `/api/media${relative}` }] }],
      })[0]);
      assert.equal(preview.proposedPayload.images[0].fileUrl.includes("localhost"), false);
      assert.equal(preview.proposedPayload.price, 66250);
      assert.equal("cost" in preview.proposedPayload, false);
      assert.equal(preview.blockers.some((blocker) => blocker.code === "missing_image"), false);
      assert.equal(preview.blockers.some((blocker) => blocker.code === "image_unreachable"), false);
      assert.equal(preview.readiness, ELRYAN_READINESS.READY);

      await Product.updateOne({ _id: productId }, { $set: { "variants.0.images.0.url": "/uploads/products/other.webp" } });
      enableWrites();
      const staleImage = await sendElryanSyncOne({
        productId,
        confirm: true,
        previewToken: preview.previewToken,
      });
      assert.equal(staleImage.code, "preview_mismatch");

      await Commission.create({
        partner: "elryan",
        scope: "all",
        targetId: "*",
        percentage: 10,
        isActive: true,
      });
      const staleRule = await sendElryanSyncOne({
        productId,
        confirm: true,
        previewToken: preview.previewToken,
      });
      assert.equal(staleRule.code, "preview_mismatch");
      const marked = await previewElryanSyncOne({ productId });
      assert.equal(marked.proposedPayload.price, applyCommissionRate(66250, 10));
      assert.equal(marked.proposedPayload.images[0].fileUrl, publicMediaUrl("/uploads/products/other.webp"));

      setElryanMediaFetchForTests(async () => imageResponse(404, "text/plain", Buffer.from("missing")));
      const unreachable = await previewElryanSyncOne({ productId });
      assert.equal(unreachable.blockers.some((blocker) => blocker.code === "image_unreachable"), true);
      assert.equal(unreachable.proposedPayload.images[0].fileUrl, publicMediaUrl("/uploads/products/other.webp"));
      assert.notEqual(unreachable.readiness, ELRYAN_READINESS.READY);
      assert.equal(posts, 0);
    } finally {
      await Commission.deleteMany({ partner: "elryan" });
      setElryanMediaFetchForTests(null);
      delete process.env.ELRYAN_PRODUCT_WRITES_ENABLED;
      delete process.env.ELRYAN_ALLOW_LIVE_PRODUCT_WRITES;
    }
  });

  it("does not post while writes are off, the preview is wrong, or the SKU is not the first test", async () => {
    await makeReady();
    const preview = await previewElryanSyncOne({ productId });
    assert.equal(preview.readiness, ELRYAN_READINESS.READY);
    assert.equal(preview.blockers.length, 0);

    const disabled = await sendElryanSyncOne({
      productId,
      confirm: true,
      previewToken: preview.previewToken,
    });
    assert.equal(disabled.code, "writes_disabled");

    process.env.ELRYAN_PRODUCT_WRITES_ENABLED = "true";
    const gated = await sendElryanSyncOne({
      productId,
      confirm: true,
      previewToken: preview.previewToken,
    });
    assert.equal(gated.code, "writes_gated");
    enableWrites();
    const unconfirmed = await sendElryanSyncOne({
      productId,
      confirm: false,
      previewToken: preview.previewToken,
    });
    assert.equal(unconfirmed.code, "confirm_required");

    const mismatch = await sendElryanSyncOne({
      productId,
      confirm: true,
      previewToken: "not-the-token",
    });
    assert.equal(mismatch.code, "preview_mismatch");

    await ElryanSyncOnePreview.updateOne({ productId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await sendElryanSyncOne({
      productId,
      confirm: true,
      previewToken: preview.previewToken,
    });
    assert.equal(expired.code, "preview_expired");

    const other = await sendElryanSyncOne({ productId: otherId, confirm: true, previewToken: "x" });
    assert.equal(other.code, "first_test_sku_only");

    await ElryanConnection.updateOne({}, { $set: { environment: "production" } });
    const production = await sendElryanSyncOne({
      productId,
      confirm: true,
      previewToken: preview.previewToken,
    });
    assert.equal(production.code, "staging_only");
    assert.equal(posts, 0);
  });

  it("ignores the staging override when the active environment is production", async () => {
    await saveElryanStagingProductOverride({
      environment: "staging",
      productId,
      sku: "OWCH180002",
      attributes: { chopper_power: 6150 },
      confirm: true,
    });
    await ElryanConnection.updateOne({}, { $set: { environment: "production" } });
    const preview = await previewElryanSyncOne({ productId });
    assert.equal(preview.connection.environment, "production");
    assert.equal(preview.stagingOverride, null);
    assert.equal(preview.proposedPayload.attributes, undefined);
    assert.equal(posts, 0);
  });

  it("blocks a taken SKU and an overlapping create before posting", async () => {
    await makeReady();
    const preview = await previewElryanSyncOne({ productId });
    enableWrites();
    mode = "sku-taken";
    const taken = await sendElryanSyncOne({
      productId,
      confirm: true,
      previewToken: preview.previewToken,
    });
    assert.equal(taken.code, "sku_unavailable");
    assert.equal(posts, 0);

    mode = "ok";
    await ElryanSendAttempt.create({
      environment: "staging",
      productId,
      sku: "OWCH180002",
      status: "in_progress",
      startedAt: new Date(),
    });
    const busy = await sendElryanSyncOne({
      productId,
      confirm: true,
      previewToken: preview.previewToken,
    });
    assert.equal(busy.code, "send_in_progress");
    assert.equal(posts, 0);
  });

  it("creates once from a mocked 201 and does not mark an in-review product published", async () => {
    await makeReady();
    const preview = await previewElryanSyncOne({ productId });
    enableWrites();
    const created = await sendElryanSyncOne({
      productId,
      confirm: true,
      previewToken: preview.previewToken,
    });
    assert.equal(created.ok, true);
    assert.equal(created.published, false);
    assert.equal(created.code, "created");
    assert.equal(created.elryanProductId, "elr-99");
    assert.equal(created.environment, "staging");
    assert.equal(createdBody.sku, "OWCH180002");
    assert.equal(createdBody.price, 66250);
    assert.equal(createdBody.cost, undefined);
    assert.equal(createdBody.attributes.chopper_power, 6150);
    assert.equal(createdBody.width, 30);
    assert.equal(createdBody.height, 40);
    assert.equal(createdBody.depth, 20);
    assert.equal(createdBody.quantity, 3);
    assert.equal(posts, 1);

    const ledger = await ElryanConfirmedSend.findOne({ productId }).lean();
    assert.equal(ledger.elryanProductId, "elr-99");
    assert.equal(ledger.sku, "OWCH180002");
    assert.equal(ledger.environment, "staging");
    assert.equal(ledger.published, false);
    assert.equal(ledger.payloadHash, created.payloadHash);

    const fresh = await previewElryanSyncOne({ productId });
    const again = await sendElryanSyncOne({
      productId,
      confirm: true,
      previewToken: fresh.previewToken,
    });
    assert.equal(again.code, "already_sent");
    assert.equal(posts, 1);
    const product = await Product.findById(productId).lean();
    assert.equal(product.price, 66250);
    assert.equal(product.itemCode, "OWCH180002");
  });

  it("records a mocked published response only when the API says published", async () => {
    await makeReady();
    const preview = await previewElryanSyncOne({ productId });
    enableWrites();
    mode = "published";
    const created = await sendElryanSyncOne({
      productId,
      confirm: true,
      previewToken: preview.previewToken,
    });
    assert.equal(created.published, true);
    assert.equal(created.code, "created_and_published");
    assert.equal(posts, 1);
  });

  it("does not record success for a mocked validation error", async () => {
    await makeReady();
    const preview = await previewElryanSyncOne({ productId });
    enableWrites();
    mode = "reject";
    const rejected = await sendElryanSyncOne({
      productId,
      confirm: true,
      previewToken: preview.previewToken,
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.code, "elryan_rejected");
    assert.equal(rejected.published, false);
    assert.equal(await ElryanConfirmedSend.countDocuments({}), 0);
    assert.equal(posts, 1);
    const reused = await sendElryanSyncOne({
      productId,
      confirm: true,
      previewToken: preview.previewToken,
    });
    assert.equal(reused.code, "preview_used");
    assert.equal(posts, 1);
  });

  it("does not retry a mocked network failure, then checks the SKU before any later create", async () => {
    await makeReady();
    const preview = await previewElryanSyncOne({ productId });
    enableWrites();
    mode = "throw";
    const uncertain = await sendElryanSyncOne({
      productId,
      confirm: true,
      previewToken: preview.previewToken,
    });
    assert.equal(uncertain.code, "create_uncertain");
    assert.equal(uncertain.published, false);
    assert.equal(await ElryanConfirmedSend.countDocuments({}), 0);
    assert.equal(posts, 1);

    const beforeAttempt = await ElryanSendAttempt.findOne({ productId }).lean();
    const next = await previewElryanSyncOne({ productId });
    mode = "ok";
    skuReads = 0;
    const blocked = await sendElryanSyncOne({
      productId,
      confirm: true,
      previewToken: next.previewToken,
    });
    assert.equal(blocked.code, "send_uncertain");
    assert.equal(posts, 1);
    assert.equal(skuReads, 0);
    assert.equal(await ElryanConfirmedSend.countDocuments({}), 0);
    const afterAttempt = await ElryanSendAttempt.findOne({ productId }).lean();
    assert.equal(afterAttempt.status, "uncertain");
    assert.equal(afterAttempt.errorCode, beforeAttempt.errorCode);
    assert.equal(afterAttempt.errorMessage, beforeAttempt.errorMessage);
    assert.equal(next.sendAttempt.status, "uncertain");
    assert.equal(next.sendAttempt.releaseAllowed, false);
  });

  it("does not let a stale in-progress attempt or an available SKU authorize another create", async () => {
    await makeReady();
    const preview = await previewElryanSyncOne({ productId });
    const startedAt = new Date(Date.now() - 10 * 60 * 1000);
    await ElryanSendAttempt.create({
      environment: "staging",
      productId,
      sku: "OWCH180002",
      status: "in_progress",
      startedAt,
      errorMessage: "left in progress",
    });
    enableWrites();
    mode = "ok";
    const blocked = await sendElryanSyncOne({
      productId,
      confirm: true,
      previewToken: preview.previewToken,
    });
    assert.equal(blocked.code, "send_in_progress");
    assert.equal(posts, 0);
    assert.equal(skuReads, 0);
    const row = await ElryanSendAttempt.findOne({ productId }).lean();
    assert.equal(row.status, "in_progress");
    assert.equal(String(row.startedAt), String(startedAt));
    assert.equal(row.errorMessage, "left in progress");
  });

  it("lets only one overlapping mocked create post", async () => {
    await makeReady();
    const preview = await previewElryanSyncOne({ productId });
    const secondPreview = await previewElryanSyncOne({ productId });
    enableWrites();
    let release;
    releaseHang = new Promise((resolve) => {
      release = resolve;
    });
    mode = "hang";
    const first = sendElryanSyncOne({
      productId,
      confirm: true,
      previewToken: preview.previewToken,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = await sendElryanSyncOne({
      productId,
      confirm: true,
      previewToken: secondPreview.previewToken,
    });
    assert.equal(second.code, "send_in_progress");
    release();
    const created = await first;
    assert.equal(created.ok, true);
    assert.equal(posts, 1);
  });
});
