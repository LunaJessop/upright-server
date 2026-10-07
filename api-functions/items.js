import { pool } from "../lib/db.js";
import { expandProductionTree, isMakeItem as isMake } from "../lib/productionTree.js";
import { resolveItemPricing } from "../lib/pricing.js";
import { syncItemTags } from "../lib/tags.js";
import {
  bomQuantityInStockUnit,
  convertQuantity,
  isCanonicalUnit,
  normalizeUnit,
  resolveBomLineUnit,
  resolveWrittenUnit,
  unitKindLabel,
  unitsAreCompatible,
} from "../lib/units.js";
import { resolveVendorId } from "./vendors.js";
import { parseEstimatedMinutes } from "../lib/estimatedMinutes.js";

const itemsSelect = `
  SELECT i.*,
    v.name AS vendor_name,
    COALESCE(
      (SELECT json_agg(json_build_object(
        'component_item_id', b.component_item_id,
        'quantity', b.quantity,
        'unit_of_measure', b.unit_of_measure))
       FROM bom_items b WHERE b.parent_item_id = i.id),
      '[]'::json
    ) AS bom_items,
    COALESCE(
      (SELECT json_agg(json_build_object(
        'id', p.id,
        'name', p.name,
        'sku', p.sku,
        'make_or_buy', p.make_or_buy)
        ORDER BY p.name)
       FROM bom_items b
       JOIN items p ON p.id = b.parent_item_id AND p.client_id = i.client_id
       WHERE b.component_item_id = i.id),
      '[]'::json
    ) AS used_in,
    COALESCE(
      (SELECT json_agg(json_build_object(
        'id', t.id,
        'name', t.name)
        ORDER BY lower(t.name))
       FROM item_tags it
       JOIN tags t ON t.id = it.tag_id
       WHERE it.item_id = i.id),
      '[]'::json
    ) AS tags,
    COALESCE(
      (SELECT json_agg(json_build_object(
        'id', s.id,
        'sku', s.sku,
        'batch_id', s.batch_id,
        'source', s.source,
        'created_at', s.created_at)
        ORDER BY s.created_at DESC)
       FROM item_skus s WHERE s.item_id = i.id),
      '[]'::json
    ) AS item_skus,
    COALESCE(
      (SELECT json_agg(json_build_object(
        'id', p.id,
        'sequence', p.sequence,
        'name', p.name,
        'description', p.description,
        'estimated_minutes', p.estimated_minutes)
        ORDER BY p.sequence)
       FROM item_router_phases p
       JOIN item_routers r ON r.id = p.router_id
       WHERE r.item_id = i.id),
      '[]'::json
    ) AS router_phases
  FROM items i
  LEFT JOIN vendors v ON v.id = i.vendor
`;

function isMakeItem(makeOrBuy) {
  return isMake(makeOrBuy);
}

function normalizeVendorSku(makeOrBuy, sku) {
  const isMake = isMakeItem(makeOrBuy);
  if (isMake) return null;
  const trimmed = sku == null ? "" : String(sku).trim();
  return trimmed === "" ? null : trimmed;
}

function validateItemPayload({ name, make_or_buy, router_phases }) {
  if (!name?.trim()) {
    return "name is required";
  }
  const isMake = isMakeItem(make_or_buy);
  if (!isMake && Array.isArray(router_phases) && router_phases.length > 0) {
    return "Router phases are only allowed for make items";
  }
  if (isMake && Array.isArray(router_phases) && router_phases.length > 0) {
    for (let i = 0; i < router_phases.length; i++) {
      const phase = router_phases[i];
      if (!phase.name?.trim()) {
        return `Phase ${i + 1} requires a name`;
      }
      const seq = Number(phase.sequence);
      if (seq !== i + 1) {
        return "Phase sequence must be 1, 2, 3… with no gaps";
      }
      const parsedMinutes = parseEstimatedMinutes(phase.estimated_minutes);
      if (!parsedMinutes.ok) {
        return parsedMinutes.error;
      }
    }
  }
  return null;
}

async function detachBatchPhasesFromItemRouter(dbClient, itemId) {
  await dbClient.query(
    `UPDATE batch_phases bp
     SET source_phase_id = NULL
     WHERE source_phase_id IN (
       SELECT p.id
       FROM item_router_phases p
       JOIN item_routers r ON r.id = p.router_id
       WHERE r.item_id = $1
     )`,
    [itemId]
  );
}

async function replaceRouterPhases(dbClient, clientId, itemId, routerPhases) {
  if (!Array.isArray(routerPhases) || routerPhases.length === 0) {
    await detachBatchPhasesFromItemRouter(dbClient, itemId);
    await dbClient.query("DELETE FROM item_routers WHERE item_id = $1", [itemId]);
    return [];
  }

  const existing = await dbClient.query(
    "SELECT id FROM item_routers WHERE item_id = $1",
    [itemId]
  );

  let routerId;
  if (existing.rows.length > 0) {
    routerId = existing.rows[0].id;
    // Batches snapshot phases and keep source_phase_id; clear before rebuild.
    await detachBatchPhasesFromItemRouter(dbClient, itemId);
    await dbClient.query("DELETE FROM item_router_phases WHERE router_id = $1", [
      routerId,
    ]);
  } else {
    const { rows } = await dbClient.query(
      `INSERT INTO item_routers (client_id, item_id)
       VALUES ($1, $2) RETURNING id`,
      [clientId, itemId]
    );
    routerId = rows[0].id;
  }

  const inserted = [];
  for (const phase of routerPhases) {
    const parsedMinutes = parseEstimatedMinutes(phase.estimated_minutes);
    if (!parsedMinutes.ok) {
      throw Object.assign(new Error(parsedMinutes.error), { status: 400 });
    }

    const { rows } = await dbClient.query(
      `INSERT INTO item_router_phases
         (router_id, sequence, name, description, estimated_minutes)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, sequence, name, description, estimated_minutes`,
      [
        routerId,
        phase.sequence,
        phase.name.trim(),
        phase.description?.trim() || null,
        parsedMinutes.minutes,
      ]
    );
    inserted.push(rows[0]);
  }

  return inserted;
}

async function clearItemRouter(dbClient, itemId) {
  await detachBatchPhasesFromItemRouter(dbClient, itemId);
  await dbClient.query("DELETE FROM item_routers WHERE item_id = $1", [itemId]);
}

function storedBomUnit(existingBom, componentId, rawLineUnit) {
  const normalized = normalizeUnit(rawLineUnit);
  if (!normalized) return undefined;
  const match = existingBom.find(
    (row) =>
      Number(row.component_item_id) === Number(componentId) &&
      normalizeUnit(row.unit_of_measure) === normalized
  );
  return match?.unit_of_measure;
}

async function assertBomComponentsBelongToClient(
  dbClient,
  clientId,
  bomItems,
  existingBom = []
) {
  if (!Array.isArray(bomItems) || bomItems.length === 0) return;

  const componentIds = [
    ...new Set(
      bomItems
        .map((line) => Number(line.component_item_id))
        .filter((id) => Number.isInteger(id) && id > 0)
    ),
  ];

  if (componentIds.length === 0) {
    throw Object.assign(new Error("Invalid BOM component ids"), { status: 400 });
  }

  const { rows } = await dbClient.query(
    `SELECT id, unit_of_measure
     FROM items
     WHERE client_id = $1 AND id = ANY($2::int[])`,
    [clientId, componentIds]
  );

  if (rows.length !== componentIds.length) {
    throw Object.assign(
      new Error("BOM components must belong to your company"),
      { status: 400 }
    );
  }

  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const line of bomItems) {
    const componentId = Number(line.component_item_id);
    const stockRaw = byId.get(componentId)?.unit_of_measure ?? "";
    const resolved = resolveBomLineUnit(
      line.unit_of_measure,
      stockRaw,
      storedBomUnit(existingBom, componentId, line.unit_of_measure)
    );
    if (!resolved.ok) {
      throw Object.assign(new Error(resolved.error), { status: 400 });
    }
    const stockUnit = normalizeUnit(stockRaw);
    const lineUnit = resolved.unit || "";
    if (lineUnit && stockUnit && !unitsAreCompatible(lineUnit, stockUnit)) {
      throw Object.assign(
        new Error(
          `BOM unit "${lineUnit}" is not compatible with component stock unit "${stockUnit}"`
        ),
        { status: 400 }
      );
    }
    const qty = Number(line.quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      throw Object.assign(new Error("BOM quantity must be greater than zero"), {
        status: 400,
      });
    }
    // Ensure conversion works when units differ
    if (
      lineUnit &&
      stockUnit &&
      lineUnit !== stockUnit &&
      bomQuantityInStockUnit(qty, lineUnit, stockUnit) == null
    ) {
      throw Object.assign(
        new Error(`Cannot convert BOM quantity from ${lineUnit} to ${stockUnit}`),
        { status: 400 }
      );
    }
  }
}

async function insertBomLines(dbClient, parentItemId, bomItems, existingBom = []) {
  for (const line of bomItems) {
    const { rows: componentRows } = await dbClient.query(
      `SELECT unit_of_measure FROM items WHERE id = $1`,
      [line.component_item_id]
    );
    const stockRaw = componentRows[0]?.unit_of_measure ?? "";
    const resolved = resolveBomLineUnit(
      line.unit_of_measure,
      stockRaw,
      storedBomUnit(existingBom, line.component_item_id, line.unit_of_measure)
    );
    if (!resolved.ok) {
      throw Object.assign(new Error(resolved.error), { status: 400 });
    }

    await dbClient.query(
      `INSERT INTO bom_items (parent_item_id, component_item_id, quantity, unit_of_measure)
       VALUES ($1, $2, $3, $4)`,
      [parentItemId, line.component_item_id, line.quantity, resolved.unit]
    );
  }
}

export async function getItems(req, res) {
  const { clientId } = req.auth;
  const tagIdRaw = req.query?.tag_id;
  const tagId =
    tagIdRaw != null && String(tagIdRaw).trim() !== ""
      ? Number(tagIdRaw)
      : null;

  try {
    const params = [clientId];
    let where = "WHERE i.client_id = $1";
    if (Number.isFinite(tagId)) {
      params.push(tagId);
      where += ` AND EXISTS (
        SELECT 1 FROM item_tags it
        WHERE it.item_id = i.id AND it.tag_id = $${params.length}
      )`;
    }
    const { rows } = await pool.query(
      `${itemsSelect} ${where} ORDER BY i.id`,
      params
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch items" });
  }
}

export async function getItemById(req, res) {
  const { id } = req.params;
  const { clientId } = req.auth;

  try {
    const { rows } = await pool.query(
      `${itemsSelect} WHERE i.id = $1 AND i.client_id = $2`,
      [id, clientId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Item not found" });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch item" });
  }
}

export async function getItemProductionTree(req, res) {
  const { id } = req.params;
  const { clientId } = req.auth;
  const quantity = Number(req.query.quantity ?? 1);

  if (!Number.isFinite(quantity) || quantity <= 0) {
    return res.status(400).json({ error: "quantity must be greater than zero" });
  }

  const dbClient = await pool.connect();
  try {
    const tree = await expandProductionTree(
      dbClient,
      clientId,
      Number(id),
      quantity
    );
    res.json(tree);
  } catch (err) {
    console.error(err);
    if (err.status === 404) {
      return res.status(404).json({ error: err.message });
    }
    res.status(500).json({ error: "Failed to expand production tree" });
  } finally {
    dbClient.release();
  }
}

export async function createItem(req, res) {
  const {
    name,
    sku,
    description,
    make_or_buy,
    unit_of_measure,
    default_unit_price,
    unit_cost,
    unit_sell_price,
    active,
    vendor,
    bom_items = [],
    router_phases = [],
    tags = [],
  } = req.body;

  const validationError = validateItemPayload({
    name,
    sku,
    make_or_buy,
    router_phases,
  });
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const pricing = resolveItemPricing(make_or_buy, {
    default_unit_price,
    unit_cost,
    unit_sell_price,
  });

  const unitResult = resolveWrittenUnit(unit_of_measure);
  if (!unitResult.ok) {
    return res.status(400).json({ error: unitResult.error });
  }

  const { clientId, userId } = req.auth;
  const vendorSku = normalizeVendorSku(make_or_buy, sku);
  const dbClient = await pool.connect();
  try {
    await dbClient.query("BEGIN");

    const resolvedVendor = isMakeItem(make_or_buy)
      ? null
      : await resolveVendorId(dbClient, clientId, vendor);

    const { rows } = await dbClient.query(
      `INSERT INTO items
         (client_id, name, sku, description, make_or_buy,
          unit_of_measure, default_unit_price, unit_cost, unit_sell_price,
          active, vendor, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
       RETURNING *`,
      [
        clientId,
        name.trim(),
        vendorSku,
        description ?? "",
        make_or_buy ?? "buy",
        unitResult.unit,
        pricing.default_unit_price,
        pricing.unit_cost,
        pricing.unit_sell_price,
        active ?? true,
        resolvedVendor,
        userId,
      ]
    );
    const item = rows[0];

    await assertBomComponentsBelongToClient(dbClient, clientId, bom_items);
    await insertBomLines(dbClient, item.id, bom_items);

    const savedPhases = isMakeItem(make_or_buy)
      ? await replaceRouterPhases(dbClient, clientId, item.id, router_phases)
      : await clearItemRouter(dbClient, item.id).then(() => []);

    const savedTags = await syncItemTags(dbClient, clientId, item.id, tags);

    await dbClient.query("COMMIT");
    res.status(201).json({
      ...item,
      bom_items,
      item_skus: [],
      router_phases: savedPhases,
      tags: savedTags,
      used_in: [],
    });
  } catch (err) {
    await dbClient.query("ROLLBACK");
    console.error(err);
    if (err.status === 400) {
      return res.status(400).json({ error: err.message });
    }
    if (err.code === "23505") {
      return res.status(409).json({ error: "Vendor part number already exists for this client" });
    }
    res.status(500).json({ error: "Failed to create item" });
  } finally {
    dbClient.release();
  }
}

function silentUnitChangeError(stored, nextUnit) {
  const storedText = stored == null ? "" : String(stored).trim();
  if (!storedText) return null;
  const previous = normalizeUnit(stored);
  const next = normalizeUnit(nextUnit);
  if (previous === next) return null;
  const fromLabel = previous || storedText;
  const toLabel = next || "no unit";
  return `This item is stocked in ${fromLabel}. Saving it as ${toLabel} would leave on-hand quantity, cost, and lots in ${fromLabel}. Change the unit with POST /api/items/:id/change-unit so those amounts convert together.`;
}

export async function updateItem(req, res) {
  const { id } = req.params;
  const {
    name,
    sku,
    description,
    make_or_buy,
    unit_of_measure,
    default_unit_price,
    unit_cost,
    unit_sell_price,
    active,
    vendor,
    bom_items = [],
    router_phases = [],
    tags = [],
  } = req.body;

  const validationError = validateItemPayload({
    name,
    sku,
    make_or_buy,
    router_phases,
  });
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const pricing = resolveItemPricing(make_or_buy, {
    default_unit_price,
    unit_cost,
    unit_sell_price,
  });

  const { clientId, userId } = req.auth;
  const vendorSku = normalizeVendorSku(make_or_buy, sku);
  const dbClient = await pool.connect();
  try {
    await dbClient.query("BEGIN");

    const existing = await dbClient.query(
      `SELECT unit_of_measure
       FROM items
       WHERE id = $1 AND client_id = $2
       FOR UPDATE`,
      [id, clientId]
    );
    if (existing.rows.length === 0) {
      await dbClient.query("ROLLBACK");
      return res.status(404).json({ error: "Item not found" });
    }

    const unitResult = resolveWrittenUnit(unit_of_measure, {
      existing: true,
      stored: existing.rows[0].unit_of_measure,
    });
    if (!unitResult.ok) {
      throw Object.assign(new Error(unitResult.error), { status: 400 });
    }
    const unitChangeError = silentUnitChangeError(
      existing.rows[0].unit_of_measure,
      unitResult.unit
    );
    if (unitChangeError) {
      throw Object.assign(new Error(unitChangeError), { status: 400 });
    }

    const { rows: existingBom } = await dbClient.query(
      `SELECT component_item_id, unit_of_measure
       FROM bom_items
       WHERE parent_item_id = $1`,
      [id]
    );

    const resolvedVendor = isMakeItem(make_or_buy)
      ? null
      : await resolveVendorId(dbClient, clientId, vendor);

    const { rows } = await dbClient.query(
      `UPDATE items
       SET name = $1,
           sku = $2,
           description = $3,
           make_or_buy = $4,
           unit_of_measure = $5,
           default_unit_price = $6,
           unit_cost = $7,
           unit_sell_price = $8,
           active = $9,
           vendor = $10,
           updated_by = $11,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $12 AND client_id = $13
       RETURNING *`,
      [
        name.trim(),
        vendorSku,
        description ?? "",
        make_or_buy ?? "buy",
        unitResult.unit,
        pricing.default_unit_price,
        pricing.unit_cost,
        pricing.unit_sell_price,
        active ?? true,
        resolvedVendor,
        userId,
        id,
        clientId,
      ]
    );

    if (rows.length === 0) {
      await dbClient.query("ROLLBACK");
      return res.status(404).json({ error: "Item not found" });
    }

    await assertBomComponentsBelongToClient(
      dbClient,
      clientId,
      bom_items,
      existingBom
    );
    await dbClient.query("DELETE FROM bom_items WHERE parent_item_id = $1", [id]);
    await insertBomLines(dbClient, id, bom_items, existingBom);

    const savedPhases = isMakeItem(make_or_buy)
      ? await replaceRouterPhases(dbClient, clientId, id, router_phases)
      : await clearItemRouter(dbClient, id).then(() => []);

    const savedTags = await syncItemTags(dbClient, clientId, Number(id), tags);

    await dbClient.query("COMMIT");

    const { rows: fullRows } = await pool.query(
      `${itemsSelect} WHERE i.id = $1 AND i.client_id = $2`,
      [id, clientId]
    );

    res.json(
      fullRows[0] ?? {
        ...rows[0],
        bom_items,
        router_phases: savedPhases,
        tags: savedTags,
      }
    );
  } catch (err) {
    await dbClient.query("ROLLBACK");
    console.error(err);
    if (err.status === 400) {
      return res.status(400).json({ error: err.message });
    }
    if (err.code === "23505") {
      return res.status(409).json({ error: "Vendor part number already exists for this client" });
    }
    res.status(500).json({ error: "Failed to update item" });
  } finally {
    dbClient.release();
  }
}

function incompatibleUnitChangeError(previous, nextUnit) {
  const fromKind = unitKindLabel(previous);
  const toKind = unitKindLabel(nextUnit);
  const kindDetail =
    fromKind && toKind
      ? ` ${previous} is ${fromKind} and ${nextUnit} is ${toKind}.`
      : "";
  return `Can't change this item from ${previous} to ${nextUnit}.${kindDetail} Pick another ${fromKind || "compatible"} unit.`;
}

async function loadItemResponse(db, itemId, clientId) {
  const { rows } = await db.query(
    `${itemsSelect} WHERE i.id = $1 AND i.client_id = $2`,
    [itemId, clientId]
  );
  return rows[0] ?? null;
}

/**
 * Convert every quantity stored in this item's stock unit.
 *
 * Open batches are refused. Completion posts batch.quantity and
 * batch_components.quantity_allocated as they were snapshotted, and a
 * completed batch has already posted. Rewriting either set would change
 * inventory that was already moved, or change what an in-progress batch
 * is about to move. Finish or cancel the batch first, then convert the
 * on-hand quantity once.
 *
 * BOM lines keep the unit they were entered in, so the next batch still
 * converts them into the new stock unit. A blank component line is stamped
 * with the previous stock unit so that number is not re-read in the new unit.
 */
export async function changeItemUnit(req, res) {
  const itemId = Number(req.params.id);
  if (!Number.isInteger(itemId) || itemId <= 0) {
    return res.status(400).json({ error: "Invalid item id" });
  }

  const unitResult = resolveWrittenUnit(req.body?.unit_of_measure);
  if (!unitResult.ok) {
    return res.status(400).json({ error: unitResult.error });
  }
  if (!unitResult.unit) {
    return res.status(400).json({
      error: "Pick a unit to change to, like oz, lb, fl oz, or mL.",
    });
  }
  const nextUnit = unitResult.unit;
  const { clientId } = req.auth;

  const dbClient = await pool.connect();
  try {
    await dbClient.query("BEGIN");

    const existing = await dbClient.query(
      `SELECT id, unit_of_measure
       FROM items
       WHERE id = $1 AND client_id = $2
       FOR UPDATE`,
      [itemId, clientId]
    );
    if (existing.rows.length === 0) {
      await dbClient.query("ROLLBACK");
      return res.status(404).json({ error: "Item not found" });
    }

    const storedRaw = existing.rows[0].unit_of_measure;
    const storedText = storedRaw == null ? "" : String(storedRaw).trim();
    const previous = normalizeUnit(storedRaw);
    if (!storedText || !previous) {
      await dbClient.query("ROLLBACK");
      return res.status(400).json({
        error:
          "This item doesn't have a unit yet. Save a unit on the item first; there's nothing to convert.",
      });
    }
    if (!isCanonicalUnit(previous)) {
      await dbClient.query("ROLLBACK");
      return res.status(400).json({
        error: `This item's unit "${storedText}" isn't a known unit, so quantities can't be converted.`,
      });
    }

    if (previous !== nextUnit) {
      if (!unitsAreCompatible(previous, nextUnit)) {
        await dbClient.query("ROLLBACK");
        return res.status(400).json({
          error: incompatibleUnitChangeError(previous, nextUnit),
        });
      }

      const factor = convertQuantity(1, previous, nextUnit);
      if (factor == null || !Number.isFinite(factor) || factor <= 0) {
        await dbClient.query("ROLLBACK");
        return res.status(400).json({
          error: `Can't convert ${previous} to ${nextUnit}.`,
        });
      }

      const { rows: openBatches } = await dbClient.query(
        `SELECT b.id
         FROM batches b
         WHERE b.client_id = $1
           AND b.status IN ('planned', 'in_progress')
           AND (
             b.item_id = $2
             OR EXISTS (
               SELECT 1
               FROM batch_components bc
               WHERE bc.batch_id = b.id
                 AND bc.item_id = $2
             )
           )
         FOR UPDATE OF b`,
        [clientId, itemId]
      );
      if (openBatches.length > 0) {
        await dbClient.query("ROLLBACK");
        return res.status(400).json({
          error: `Finish or cancel open batches that use this item before changing its unit from ${previous} to ${nextUnit}. An open batch still has quantities in ${previous}.`,
        });
      }

      await dbClient.query(
        `UPDATE inventory
         SET quantity = quantity * $1::numeric,
             updated_at = CURRENT_TIMESTAMP
         WHERE client_id = $2 AND item_id = $3`,
        [factor, clientId, itemId]
      );
      await dbClient.query(
        `UPDATE item_inventory_goals
         SET goal_min = goal_min * $1::numeric,
             goal_max = goal_max * $1::numeric,
             updated_at = CURRENT_TIMESTAMP
         WHERE client_id = $2 AND item_id = $3`,
        [factor, clientId, itemId]
      );
      await dbClient.query(
        `UPDATE purchase_lots
         SET quantity = quantity * $1::numeric,
             unit_cost = unit_cost / $1::numeric
         WHERE client_id = $2 AND item_id = $3`,
        [factor, clientId, itemId]
      );
      await dbClient.query(
        `UPDATE bom_items
         SET unit_of_measure = $1
         WHERE component_item_id = $2
           AND (unit_of_measure IS NULL OR btrim(unit_of_measure) = '')`,
        [previous, itemId]
      );
      await dbClient.query(
        `UPDATE items
         SET unit_of_measure = $1,
             unit_cost = CASE
               WHEN unit_cost IS NULL THEN NULL
               ELSE unit_cost / $2::numeric
             END,
             unit_sell_price = CASE
               WHEN unit_sell_price IS NULL THEN NULL
               ELSE unit_sell_price / $2::numeric
             END,
             default_unit_price = CASE
               WHEN default_unit_price IS NULL THEN NULL
               ELSE default_unit_price / $2::numeric
             END,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $3 AND client_id = $4`,
        [nextUnit, factor, itemId, clientId]
      );
    } else if (String(storedRaw) !== nextUnit) {
      await dbClient.query(
        `UPDATE items
         SET unit_of_measure = $1,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $2 AND client_id = $3`,
        [nextUnit, itemId, clientId]
      );
    }

    const item = await loadItemResponse(dbClient, itemId, clientId);
    if (!item) {
      await dbClient.query("ROLLBACK");
      return res.status(404).json({ error: "Item not found" });
    }

    await dbClient.query("COMMIT");
    res.json(item);
  } catch (err) {
    await dbClient.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Failed to change item unit" });
  } finally {
    dbClient.release();
  }
}

function itemInUseError(recipes, batches) {
  const parts = [];
  if (recipes.length > 0) {
    parts.push(`Used in the recipe for: ${recipes.join(", ")}`);
  }
  if (batches.length > 0) {
    parts.push(`Used in active batch: ${batches.join(", ")}`);
  }
  return parts.join(". ");
}

export async function deleteItem(req, res) {
  const { id } = req.params;
  const { clientId } = req.auth;
  const dbClient = await pool.connect();
  try {
    await dbClient.query("BEGIN");

    const owned = await dbClient.query(
      `SELECT id FROM items WHERE id = $1 AND client_id = $2 FOR UPDATE`,
      [id, clientId]
    );
    if (owned.rows.length === 0) {
      await dbClient.query("ROLLBACK");
      return res.status(404).json({ error: "Item not found" });
    }

    const { rows: recipeRows } = await dbClient.query(
      `SELECT DISTINCT p.name
       FROM bom_items b
       JOIN items p ON p.id = b.parent_item_id
       WHERE b.component_item_id = $1
         AND p.client_id = $2
         AND b.parent_item_id <> $1
       ORDER BY p.name`,
      [id, clientId]
    );
    const { rows: batchRows } = await dbClient.query(
      `SELECT DISTINCT COALESCE(NULLIF(btrim(b.sku), ''), finished.name, 'Batch ' || b.id::text) AS label
       FROM batches b
       JOIN items finished ON finished.id = b.item_id
       WHERE b.client_id = $2
         AND b.status IN ('planned', 'in_progress')
         AND (
           b.item_id = $1
           OR EXISTS (
             SELECT 1
             FROM batch_components bc
             WHERE bc.batch_id = b.id
               AND bc.item_id = $1
           )
         )
       ORDER BY label`,
      [id, clientId]
    );

    const recipes = recipeRows.map((row) => row.name).filter(Boolean);
    const batches = batchRows.map((row) => row.label).filter(Boolean);
    if (recipes.length > 0 || batches.length > 0) {
      await dbClient.query("ROLLBACK");
      return res.status(409).json({ error: itemInUseError(recipes, batches) });
    }

    await dbClient.query(
      "DELETE FROM bom_items WHERE parent_item_id = $1 OR component_item_id = $1",
      [id]
    );
    await dbClient.query("DELETE FROM items WHERE id = $1", [id]);
    await dbClient.query("COMMIT");
    res.status(204).end();
  } catch (err) {
    await dbClient.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Failed to delete item" });
  } finally {
    dbClient.release();
  }
}
