import { bomQuantityInStockUnit } from "./units.js";

/**
 * Expands a make item's BOM into:
 * - needs: rolled-up component requirements
 * - phaseGroups: depth-first make children then parent, each with router phases
 */
export function isMakeItem(makeOrBuy) {
  return makeOrBuy === "make" || makeOrBuy === true || makeOrBuy === "true";
}

export async function loadItemRouterPhases(dbClient, itemId) {
  const { rows } = await dbClient.query(
    `SELECT p.id, p.sequence, p.name, p.description, p.estimated_minutes
     FROM item_router_phases p
     JOIN item_routers r ON r.id = p.router_id
     WHERE r.item_id = $1
     ORDER BY p.sequence`,
    [itemId]
  );
  return rows;
}

export async function loadBomLinesWithItems(dbClient, parentItemId) {
  const { rows } = await dbClient.query(
    `SELECT b.component_item_id,
            b.quantity,
            b.unit_of_measure AS bom_unit_of_measure,
            i.name AS component_name,
            i.make_or_buy,
            i.unit_of_measure
     FROM bom_items b
     JOIN items i ON i.id = b.component_item_id
     WHERE b.parent_item_id = $1
     ORDER BY i.name ASC`,
    [parentItemId]
  );
  return rows;
}

/**
 * @returns {{
 *   needs: Array<{ item_id, name, make_or_buy, unit_of_measure, quantity }>,
 *   phaseGroups: Array<{ item_id, name, quantity, unit_of_measure, phases }>
 * }}
 */
export async function expandProductionTree(
  dbClient,
  clientId,
  rootItemId,
  rootQuantity
) {
  const needsMap = new Map();
  const phaseGroups = [];
  const visiting = new Set();

  const { rows: rootRows } = await dbClient.query(
    `SELECT id, name, make_or_buy, unit_of_measure
     FROM items
     WHERE id = $1 AND client_id = $2`,
    [rootItemId, clientId]
  );
  if (rootRows.length === 0) {
    throw Object.assign(new Error("Item not found"), { status: 404 });
  }
  const root = rootRows[0];

  async function walkMake(item, quantity) {
    if (visiting.has(item.id)) return;
    visiting.add(item.id);

    const bomLines = await loadBomLinesWithItems(dbClient, item.id);
    for (const line of bomLines) {
      const stockUnit = line.unit_of_measure ?? "";
      const lineUnit = line.bom_unit_of_measure || stockUnit;
      const perParentInStock = bomQuantityInStockUnit(
        line.quantity,
        lineUnit,
        stockUnit
      );
      if (perParentInStock == null) {
        throw Object.assign(
          new Error(
            `Cannot convert BOM for ${line.component_name} from ${lineUnit || "?"} to ${stockUnit || "?"}`
          ),
          { status: 400 }
        );
      }

      const needQty = Number(perParentInStock) * Number(quantity);
      if (!Number.isFinite(needQty) || needQty <= 0) continue;

      const existing = needsMap.get(line.component_item_id);
      if (existing) {
        existing.quantity += needQty;
      } else {
        needsMap.set(line.component_item_id, {
          item_id: line.component_item_id,
          name: line.component_name,
          make_or_buy: isMakeItem(line.make_or_buy) ? "make" : "buy",
          unit_of_measure: stockUnit,
          quantity: needQty,
        });
      }

      if (isMakeItem(line.make_or_buy)) {
        const { rows: childRows } = await dbClient.query(
          `SELECT id, name, make_or_buy, unit_of_measure
           FROM items
           WHERE id = $1 AND client_id = $2`,
          [line.component_item_id, clientId]
        );
        if (childRows.length > 0) {
          await walkMake(childRows[0], needQty);
        }
      }
    }

    const phases = await loadItemRouterPhases(dbClient, item.id);
    if (phases.length > 0) {
      phaseGroups.push({
        item_id: item.id,
        name: item.name,
        quantity: Number(quantity),
        unit_of_measure: item.unit_of_measure,
        phases,
      });
    }

    visiting.delete(item.id);
  }

  await walkMake(root, rootQuantity);

  return {
    needs: [...needsMap.values()].sort((a, b) =>
      a.name.localeCompare(b.name)
    ),
    phaseGroups,
  };
}
