import { pool } from "../index.js";

const itemsSelect = `
  SELECT i.*,
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
    ) AS item_skus
  FROM items i
`;

function normalizeVendorSku(makeOrBuy, sku) {
  const isMake =
    makeOrBuy === "make" || makeOrBuy === true || makeOrBuy === "true";
  if (isMake) return null;
  const trimmed = sku == null ? "" : String(sku).trim();
  return trimmed === "" ? null : trimmed;
}

function validateItemPayload({ name, sku, make_or_buy }) {
  if (!name?.trim()) {
    return "name is required";
  }
  const isMake =
    make_or_buy === "make" || make_or_buy === true || make_or_buy === "true";
  if (!isMake && !normalizeVendorSku(make_or_buy, sku)) {
    return "Vendor part number is required for buy items";
  }
  return null;
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
  } = req.body;

  const validationError = validateItemPayload({ name, sku, make_or_buy });
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const { clientId, userId } = req.auth;
  const vendorSku = normalizeVendorSku(make_or_buy, sku);
  const dbClient = await pool.connect();
  try {
    await dbClient.query("BEGIN");

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
        vendor === "" ? null : vendor,
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

    await dbClient.query("COMMIT");
    res.status(201).json({ ...item, bom_items, item_skus: [] });
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
  } = req.body;

  const validationError = validateItemPayload({ name, sku, make_or_buy });
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const { clientId, userId } = req.auth;
  const vendorSku = normalizeVendorSku(make_or_buy, sku);
  const dbClient = await pool.connect();
  try {
    await dbClient.query("BEGIN");

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
        vendor === "" ? null : vendor,
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

    await dbClient.query("COMMIT");

    const { rows: skuRows } = await pool.query(
      `SELECT id, sku, batch_id, source, created_at
       FROM item_skus WHERE item_id = $1 AND client_id = $2
       ORDER BY created_at DESC`,
      [id, clientId]
    );

    res.json({ ...item, bom_items, item_skus: skuRows });
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
