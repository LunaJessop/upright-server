import { isMakeItem } from "./productionTree.js";

function toMoney(value) {
  if (value === "" || value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Resolve cost / sell from payload + legacy default_unit_price.
 * Buy → unit_cost; Make → unit_sell_price.
 * Keeps default_unit_price synced for older clients.
 */
export function resolveItemPricing(makeOrBuy, body = {}) {
  const isMake = isMakeItem(makeOrBuy);
  const legacy = toMoney(body.default_unit_price);
  const unitCost = toMoney(
    body.unit_cost !== undefined ? body.unit_cost : isMake ? null : legacy
  );
  const unitSell = toMoney(
    body.unit_sell_price !== undefined
      ? body.unit_sell_price
      : isMake
        ? legacy
        : null
  );

  return {
    unit_cost: isMake ? unitCost : unitCost ?? legacy,
    unit_sell_price: isMake ? unitSell ?? legacy : unitSell,
    // Compat mirror: primary price for that item type
    default_unit_price: isMake
      ? unitSell ?? legacy
      : unitCost ?? legacy,
  };
}

/**
 * Snapshot batch economics from finished sell price + buy-component costs.
 * @param {Array<{ make_or_buy, quantity, unit_cost }>} needs
 */
export function computeBatchEconomics({ quantity, unitSellPrice, needs }) {
  const qty = Number(quantity);
  const unitSell = toMoney(unitSellPrice) ?? 0;

  let projectedCost = 0;
  const lines = [];

  for (const need of needs ?? []) {
    const needQty = Number(need.quantity);
    if (!Number.isFinite(needQty) || needQty <= 0) continue;

    const isBuy = !isMakeItem(need.make_or_buy);
    const unitCost = isBuy ? toMoney(need.unit_cost) : null;
    const lineCost =
      isBuy && unitCost != null && Number.isFinite(needQty)
        ? unitCost * needQty
        : null;

    if (lineCost != null) {
      projectedCost += lineCost;
    }

    lines.push({
      item_id: need.item_id,
      quantity: needQty,
      unit_cost_snapshot: isBuy ? unitCost : null,
      line_cost: lineCost,
    });
  }

  const projectedRevenue =
    Number.isFinite(qty) && qty > 0 ? unitSell * qty : 0;
  const projectedProfit = projectedRevenue - projectedCost;
  const projectedMargin =
    projectedRevenue > 0 ? projectedProfit / projectedRevenue : null;
  const projectedUnitCost =
    Number.isFinite(qty) && qty > 0 ? projectedCost / qty : null;

  return {
    projected_cost: projectedCost,
    projected_revenue: projectedRevenue,
    projected_profit: projectedProfit,
    projected_margin: projectedMargin,
    projected_unit_cost: projectedUnitCost,
    projected_unit_sell: unitSell,
    lines,
  };
}

export function formatMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export function formatMargin(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return `${(n * 100).toLocaleString("en-US", {
    maximumFractionDigits: 1,
  })}%`;
}
