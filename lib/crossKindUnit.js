import { convertQuantity, normalizeUnit } from "./units.js";

const SPOKEN_UNITS = {
  ea: "each",
  fl_oz: "fl oz",
  oz: "oz",
  lb: "lb",
  g: "g",
  kg: "kg",
  mL: "mL",
  L: "L",
};

export function spokenUnit(unit) {
  const canonical = normalizeUnit(unit);
  if (SPOKEN_UNITS[canonical]) return SPOKEN_UNITS[canonical];
  if (!canonical) return "";
  return canonical.replaceAll("_", " ");
}

/**
 * `factor` means how many of the old unit equal 1 of the new unit.
 * Missing is not the same as an unusable number.
 */
export function parseConversionFactor(raw) {
  if (raw == null) return { state: "missing" };
  if (typeof raw === "boolean") return { state: "invalid" };
  if (typeof raw === "string" && raw.trim() === "") return { state: "missing" };
  const factor = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(factor) || factor <= 0) return { state: "invalid" };
  return { state: "ok", factor };
}

export function isDryRun(value) {
  return value === true || value === "true";
}

function finiteNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Line quantity restated in the item's old stock unit. */
export function quantityInStockUnit(quantity, lineUnit, stockUnit) {
  const qty = finiteNumber(quantity);
  if (qty == null) return null;
  const line = normalizeUnit(lineUnit);
  const stock = normalizeUnit(stockUnit);
  if (!line || !stock || line === stock) return qty;
  const converted = convertQuantity(qty, line, stock);
  return converted == null ? qty : converted;
}

function divide(value, factor) {
  const n = finiteNumber(value);
  if (n == null) return null;
  return n / factor;
}

function multiply(value, factor) {
  const n = finiteNumber(value);
  if (n == null) return null;
  return n * factor;
}

function pair(before, after) {
  return { before, after };
}

/**
 * How much would have to move. A zero count means the unit can change
 * with no factor.
 */
export function conversionCounts(snapshot) {
  const onHand = finiteNumber(snapshot?.onHand);
  const stock =
    (onHand != null && onHand !== 0 ? 1 : 0) +
    (snapshot?.lots?.length ?? 0) +
    (snapshot?.goals ? 1 : 0);
  const recipes =
    (snapshot?.ingredientLines?.length ?? 0) +
    (snapshot?.ownRecipeLines?.length ?? 0);
  const batchIds = new Set();
  for (const batch of snapshot?.finishedBatches ?? []) {
    batchIds.add(Number(batch.id));
  }
  for (const line of snapshot?.componentLines ?? []) {
    batchIds.add(Number(line.batchId));
  }
  return { stock, recipes, batches: batchIds.size };
}

export function conversionRequired(snapshot) {
  const counts = conversionCounts(snapshot);
  return counts.stock + counts.recipes + counts.batches > 0;
}

export function buildCrossKindPreview({ fromUnit, toUnit, factor, snapshot }) {
  const counts = conversionCounts(snapshot);
  const convert = factor != null;
  const onHand = finiteNumber(snapshot?.onHand) ?? 0;
  const goals = snapshot?.goals ?? null;
  const prices = snapshot?.prices ?? {};

  return {
    dryRun: true,
    converted: convert,
    fromUnit,
    toUnit,
    factor: convert ? factor : null,
    prompt: `How many ${spokenUnit(fromUnit)} is 1 ${spokenUnit(toUnit)}?`,
    counts,
    stock: {
      quantity: pair(onHand, convert ? divide(onHand, factor) : onHand),
      goalMin: goals
        ? pair(
            finiteNumber(goals.goalMin),
            convert ? divide(goals.goalMin, factor) : finiteNumber(goals.goalMin)
          )
        : null,
      goalMax: goals
        ? pair(
            finiteNumber(goals.goalMax),
            convert ? divide(goals.goalMax, factor) : finiteNumber(goals.goalMax)
          )
        : null,
      unitCost: pair(
        finiteNumber(prices.unitCost),
        convert ? multiply(prices.unitCost, factor) : finiteNumber(prices.unitCost)
      ),
      unitSellPrice: pair(
        finiteNumber(prices.unitSellPrice),
        convert
          ? multiply(prices.unitSellPrice, factor)
          : finiteNumber(prices.unitSellPrice)
      ),
      defaultUnitPrice: pair(
        finiteNumber(prices.defaultUnitPrice),
        convert
          ? multiply(prices.defaultUnitPrice, factor)
          : finiteNumber(prices.defaultUnitPrice)
      ),
      purchaseLots: (snapshot?.lots ?? []).map((lot) => ({
        id: lot.id,
        lotNumber: lot.lotNumber ?? null,
        quantity: pair(
          finiteNumber(lot.quantity),
          convert ? divide(lot.quantity, factor) : finiteNumber(lot.quantity)
        ),
        unitCost: pair(
          finiteNumber(lot.unitCost),
          convert ? multiply(lot.unitCost, factor) : finiteNumber(lot.unitCost)
        ),
      })),
    },
    recipes: (snapshot?.ingredientLines ?? []).map((line) => {
      const before = quantityInStockUnit(line.quantity, line.unit, fromUnit);
      return {
        parentItemId: line.parentItemId,
        parentName: line.parentName ?? null,
        enteredQuantity: finiteNumber(line.quantity),
        enteredUnit: normalizeUnit(line.unit) || fromUnit,
        before,
        after: convert ? divide(before, factor) : before,
        unitBefore: fromUnit,
        unitAfter: toUnit,
      };
    }),
    ownRecipe: (snapshot?.ownRecipeLines ?? []).map((line) => ({
      componentItemId: line.componentItemId,
      componentName: line.componentName ?? null,
      unit: normalizeUnit(line.unit) || null,
      before: finiteNumber(line.quantity),
      after: convert ? multiply(line.quantity, factor) : finiteNumber(line.quantity),
    })),
    batches: [
      ...(snapshot?.finishedBatches ?? []).map((batch) => ({
        batchId: batch.id,
        sku: batch.sku ?? null,
        status: batch.status ?? null,
        role: "finished",
        before: finiteNumber(batch.quantity),
        after: convert ? divide(batch.quantity, factor) : finiteNumber(batch.quantity),
        unitBefore: fromUnit,
        unitAfter: toUnit,
      })),
      ...(snapshot?.componentLines ?? []).map((line) => ({
        batchId: line.batchId,
        componentId: line.id ?? null,
        sku: line.sku ?? null,
        status: line.status ?? null,
        role: "component",
        enteredUnit: normalizeUnit(line.unit) || fromUnit,
        before: finiteNumber(line.quantity),
        after: convert ? divide(line.quantity, factor) : finiteNumber(line.quantity),
        unitBefore: fromUnit,
        unitAfter: toUnit,
      })),
    ],
  };
}
