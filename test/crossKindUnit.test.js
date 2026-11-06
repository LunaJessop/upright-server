import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildCrossKindPreview,
  conversionCounts,
  conversionRequired,
  parseConversionFactor,
  quantityInStockUnit,
} from "../lib/crossKindUnit.js";

describe("cross-kind conversion factor", () => {
  it("treats a blank factor as missing and a bad one as invalid", () => {
    assert.deepEqual(parseConversionFactor(undefined), { state: "missing" });
    assert.deepEqual(parseConversionFactor(null), { state: "missing" });
    assert.deepEqual(parseConversionFactor(""), { state: "missing" });
    assert.deepEqual(parseConversionFactor("  "), { state: "missing" });
    assert.equal(parseConversionFactor("8").factor, 8);
    assert.equal(parseConversionFactor(8.5).factor, 8.5);
    assert.equal(parseConversionFactor(0).state, "invalid");
    assert.equal(parseConversionFactor(-2).state, "invalid");
    assert.equal(parseConversionFactor("nope").state, "invalid");
    assert.equal(parseConversionFactor(Number.POSITIVE_INFINITY).state, "invalid");
    assert.equal(parseConversionFactor(true).state, "invalid");
  });

  it("restates a recipe line in the old stock unit before the factor is applied", () => {
    assert.equal(quantityInStockUnit(2, "cup", "fl_oz"), 16);
    assert.equal(quantityInStockUnit(4, "", "fl_oz"), 4);
    assert.equal(quantityInStockUnit(4, "fl_oz", "fl_oz"), 4);
  });

  it("counts stock, recipe lines, and distinct batches", () => {
    const counts = conversionCounts({
      onHand: 0,
      lots: [{ id: 1 }],
      goals: { goalMin: 1, goalMax: 2 },
      ingredientLines: [{ parentItemId: 3 }],
      ownRecipeLines: [],
      finishedBatches: [{ id: 9 }],
      componentLines: [{ batchId: 9 }, { batchId: 10 }],
    });
    assert.deepEqual(counts, { stock: 2, recipes: 1, batches: 2 });
    assert.equal(conversionRequired({ onHand: 0, lots: [], goals: null }), false);
    assert.equal(conversionRequired({ onHand: "16" }), true);
  });

  it("divides quantities and multiplies prices by how many old units make one new unit", () => {
    const preview = buildCrossKindPreview({
      fromUnit: "fl_oz",
      toUnit: "ea",
      factor: 8,
      snapshot: {
        onHand: 16,
        prices: { unitCost: 0.5, unitSellPrice: null, defaultUnitPrice: null },
        lots: [],
        ingredientLines: [
          { parentItemId: 3, parentName: "Soap", quantity: 2, unit: "cup" },
        ],
        ownRecipeLines: [
          { componentItemId: 6, componentName: "Oil", quantity: 1, unit: "oz" },
        ],
        finishedBatches: [{ id: 9, sku: "LOT-1", status: "complete", quantity: 8 }],
        componentLines: [],
      },
    });

    assert.equal(preview.prompt, "How many fl oz is 1 each?");
    assert.deepEqual(preview.stock.quantity, { before: 16, after: 2 });
    assert.deepEqual(preview.stock.unitCost, { before: 0.5, after: 4 });
    assert.equal(preview.stock.unitSellPrice.after, null);
    assert.equal(preview.recipes[0].before, 16);
    assert.equal(preview.recipes[0].after, 2);
    assert.equal(preview.ownRecipe[0].after, 8);
    assert.equal(preview.batches[0].after, 1);
    assert.equal(preview.counts.batches, 1);
  });
});
