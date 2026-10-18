import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyCommissionRate, roundUpPlatformPrice } from "./utils/commission.js";
import { partnerPricePreview, toPartnerProduct } from "./utils/partnerCatalog.js";

describe("platform price rounding", () => {
  it("rounds a raw platform price up to the next 250 IQD", () => {
    assert.equal(roundUpPlatformPrice(6999), 7000);
    assert.equal(roundUpPlatformPrice(7000), 7000);
    assert.equal(roundUpPlatformPrice(7001), 7250);
    assert.equal(roundUpPlatformPrice(7249), 7250);
    assert.equal(roundUpPlatformPrice(7250), 7250);
    assert.equal(roundUpPlatformPrice(7251), 7500);
    assert.equal(roundUpPlatformPrice(7700), 7750);
    assert.equal(roundUpPlatformPrice(7999), 8000);
    assert.equal(roundUpPlatformPrice(8000), 8000);
    assert.equal(roundUpPlatformPrice(0), 0);
    assert.equal(roundUpPlatformPrice(-10), 0);
  });

  it("rounds only after the commission rate is applied", () => {
    assert.equal(applyCommissionRate(7000, 10), 7750);
    assert.equal(applyCommissionRate(100000, 10), 110000);
    assert.equal(applyCommissionRate(100000, 7), 107000);
    assert.equal(applyCommissionRate(100000, 7.1), 107250);
    assert.equal(applyCommissionRate(7001, 0), 7250);
    assert.equal(applyCommissionRate(0, 10), 0);
  });

  it("uses the same rounded price for every platform and leaves the selling price unchanged", () => {
    const product = {
      _id: "price-1",
      ibsherId: "price-1",
      price: 7000,
      discountPrice: 0,
      name: { en: "Electric Blender", ar: "خلاط كهربائي", ku: "خڵات" },
      brand: { _id: "brand-1", name: { en: "Philips" } },
    };
    const rules = [{ scope: "brand", targetId: "brand-1", percentage: 10, isActive: true }];
    const preview = partnerPricePreview(product, rules);
    const partnerProduct = toPartnerProduct(product, rules, "http://localhost");

    assert.equal(preview.storePrice, 7000);
    assert.equal(preview.price, 7750);
    assert.equal(partnerProduct.price, preview.price);
    assert.equal(product.price, 7000);
    assert.equal(product.discountPrice, 0);

    const untouched = {
      _id: "price-0",
      price: 7001,
      discountPrice: 0,
      brand: { _id: "brand-2" },
    };
    assert.equal(partnerPricePreview(untouched, []).price, 7250);
    assert.equal(partnerPricePreview(untouched, []).storePrice, 7001);
    assert.equal(untouched.price, 7001);
  });
});
