import { pool } from "../index.js";

export async function getItems(_req, res) {
  try {
    const { rows } = await pool.query(`
      SELECT i.*,
        COALESCE(
          (SELECT json_agg(json_build_object(
            'component_item_id', b.component_item_id,
            'quantity', b.quantity))
           FROM bom_items b WHERE b.parent_item_id = i.id),
          '[]'::json
        ) AS bom_items
      FROM items i ORDER BY i.id
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch items" });
  }
}

export async function getItemById(req, res) {
  const { id } = req.params;

  try {
    const { rows } = await pool.query(
      `
      SELECT i.*,
        COALESCE(
          (SELECT json_agg(json_build_object(
            'component_item_id', b.component_item_id,
            'quantity', b.quantity))
           FROM bom_items b WHERE b.parent_item_id = i.id),
          '[]'::json
        ) AS bom_items
      FROM items i
      WHERE i.id = $1
      `,
      [id]
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
    organization_id,
    name,
    sku,
    description,
    make_or_buy,
    unit_of_measure,
    default_cost,
    active,
    vendor,
    bom_items = [],
  } = req.body;

  if (!name || !sku) {
    return res.status(400).json({ error: "name and sku are required" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `INSERT INTO items
         (organization_id, name, sku, description, make_or_buy,
          unit_of_measure, default_cost, active, vendor)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        organization_id ?? 1,
        name,
        sku,
        description ?? "",
        make_or_buy ?? "buy",
        unit_of_measure ?? "",
        default_cost === "" ? null : default_cost,
        active ?? true,
        vendor === "" ? null : vendor,
      ]
    );
    const item = rows[0];

    for (const line of bom_items) {
      await client.query(
        `INSERT INTO bom_items (parent_item_id, component_item_id, quantity)
         VALUES ($1, $2, $3)`,
        [item.id, line.component_item_id, line.quantity]
      );
    }

    await client.query("COMMIT");
    res.status(201).json({ ...item, bom_items });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Failed to create item" });
  } finally {
    client.release();
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
    default_cost,
    active,
    vendor,
    bom_items = [],
  } = req.body;

  if (!name || !sku) {
    return res.status(400).json({ error: "name and sku are required" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `UPDATE items
       SET name = $1,
           sku = $2,
           description = $3,
           make_or_buy = $4,
           unit_of_measure = $5,
           default_cost = $6,
           active = $7,
           vendor = $8,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $9
       RETURNING *`,
      [
        name,
        sku,
        description ?? "",
        make_or_buy ?? "buy",
        unit_of_measure ?? "",
        default_cost === "" ? null : default_cost,
        active ?? true,
        vendor === "" ? null : vendor,
        id,
      ]
    );

    if (rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Item not found" });
    }
    const item = rows[0];

    // Replace the recipe wholesale — delete old lines, insert current ones
    await client.query("DELETE FROM bom_items WHERE parent_item_id = $1", [id]);
    for (const line of bom_items) {
      await client.query(
        `INSERT INTO bom_items (parent_item_id, component_item_id, quantity)
         VALUES ($1, $2, $3)`,
        [id, line.component_item_id, line.quantity]
      );
    }

    await client.query("COMMIT");
    res.json({ ...item, bom_items });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Failed to update item" });
  } finally {
    client.release();
  }
}

export async function deleteItem(req, res) {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Remove BOM lines that reference this item as parent or component
    await client.query(
      "DELETE FROM bom_items WHERE parent_item_id = $1 OR component_item_id = $1",
      [id]
    );
    const { rowCount } = await client.query("DELETE FROM items WHERE id = $1", [id]);
    await client.query("COMMIT");
    if (rowCount === 0) {
      return res.status(404).json({ error: "Item not found" });
    }
    res.status(204).end();
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Failed to delete item" });
  } finally {
    client.release();
  }
}