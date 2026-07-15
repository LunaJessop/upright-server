import { pool } from "../lib/db.js";
import { expandProductionTree, isMakeItem as isMake } from "../lib/productionTree.js";
import { resolveVendorId } from "./vendors.js";

const itemsSelect = `
  SELECT i.*,
    v.name AS vendor_name,
    COALESCE(
      (SELECT json_agg(json_build_object(
        'component_item_id', b.component_item_id,
        'quantity', b.quantity))
       FROM bom_items b WHERE b.parent_item_id = i.id),
      '[]'::json
    ) AS bom_items,
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

function validateItemPayload({ name, sku, make_or_buy, router_phases }) {
  if (!name?.trim()) {
    return "name is required";
  }
  const isMake = isMakeItem(make_or_buy);
  if (!isMake && !normalizeVendorSku(make_or_buy, sku)) {
    return "Vendor part number is required for buy items";
  }
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
        phase.estimated_minutes == null || phase.estimated_minutes === ""
          ? null
          : Number(phase.estimated_minutes),
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

async function assertBomComponentsBelongToClient(dbClient, clientId, bomItems) {
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
    "SELECT id FROM items WHERE client_id = $1 AND id = ANY($2::int[])",
    [clientId, componentIds]
  );

  if (rows.length !== componentIds.length) {
    throw Object.assign(
      new Error("BOM components must belong to your company"),
      { status: 400 }
    );
  }
}

export async function getItems(req, res) {
  const { clientId } = req.auth;
  try {
    const { rows } = await pool.query(
      `${itemsSelect} WHERE i.client_id = $1 ORDER BY i.id`,
      [clientId]
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
    active,
    vendor,
    bom_items = [],
    router_phases = [],
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
          unit_of_measure, default_unit_price, active, vendor, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
       RETURNING *`,
      [
        clientId,
        name.trim(),
        vendorSku,
        description ?? "",
        make_or_buy ?? "buy",
        unit_of_measure ?? "",
        default_unit_price === "" ? null : default_unit_price,
        active ?? true,
        resolvedVendor,
        userId,
      ]
    );
    const item = rows[0];

    await assertBomComponentsBelongToClient(dbClient, clientId, bom_items);

    for (const line of bom_items) {
      await dbClient.query(
        `INSERT INTO bom_items (parent_item_id, component_item_id, quantity)
         VALUES ($1, $2, $3)`,
        [item.id, line.component_item_id, line.quantity]
      );
    }

    const savedPhases = isMakeItem(make_or_buy)
      ? await replaceRouterPhases(dbClient, clientId, item.id, router_phases)
      : await clearItemRouter(dbClient, item.id).then(() => []);

    await dbClient.query("COMMIT");
    res.status(201).json({
      ...item,
      bom_items,
      item_skus: [],
      router_phases: savedPhases,
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

export async function updateItem(req, res) {
  const { id } = req.params;
  const {
    name,
    sku,
    description,
    make_or_buy,
    unit_of_measure,
    default_unit_price,
    active,
    vendor,
    bom_items = [],
    router_phases = [],
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

  const { clientId, userId } = req.auth;
  const vendorSku = normalizeVendorSku(make_or_buy, sku);
  const dbClient = await pool.connect();
  try {
    await dbClient.query("BEGIN");

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
           active = $7,
           vendor = $8,
           updated_by = $9,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $10 AND client_id = $11
       RETURNING *`,
      [
        name.trim(),
        vendorSku,
        description ?? "",
        make_or_buy ?? "buy",
        unit_of_measure ?? "",
        default_unit_price === "" ? null : default_unit_price,
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
    const item = rows[0];

    await assertBomComponentsBelongToClient(dbClient, clientId, bom_items);

    await dbClient.query("DELETE FROM bom_items WHERE parent_item_id = $1", [id]);
    for (const line of bom_items) {
      await dbClient.query(
        `INSERT INTO bom_items (parent_item_id, component_item_id, quantity)
         VALUES ($1, $2, $3)`,
        [id, line.component_item_id, line.quantity]
      );
    }

    const savedPhases = isMakeItem(make_or_buy)
      ? await replaceRouterPhases(dbClient, clientId, id, router_phases)
      : await clearItemRouter(dbClient, id).then(() => []);

    await dbClient.query("COMMIT");

    const { rows: skuRows } = await pool.query(
      `SELECT id, sku, batch_id, source, created_at
       FROM item_skus WHERE item_id = $1 AND client_id = $2
       ORDER BY created_at DESC`,
      [id, clientId]
    );

    res.json({
      ...item,
      bom_items,
      item_skus: skuRows,
      router_phases: savedPhases,
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
    res.status(500).json({ error: "Failed to update item" });
  } finally {
    dbClient.release();
  }
}

export async function deleteItem(req, res) {
  const { id } = req.params;
  const { clientId } = req.auth;
  const dbClient = await pool.connect();
  try {
    await dbClient.query("BEGIN");

    const owned = await dbClient.query(
      "SELECT id FROM items WHERE id = $1 AND client_id = $2",
      [id, clientId]
    );
    if (owned.rows.length === 0) {
      await dbClient.query("ROLLBACK");
      return res.status(404).json({ error: "Item not found" });
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
