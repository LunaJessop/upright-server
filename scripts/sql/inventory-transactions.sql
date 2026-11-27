-- Inventory transaction log. Do not run until Luna approves.
-- Safe to run more than once. Existing stock is not copied in.
-- An item with stock and no rows simply has an empty history.
--
-- Reasons are checked in the API, not with a database CHECK.
-- The note length (500) is also checked in the API.
--
-- Deleting an item removes its rows. Deleting a batch or a purchase lot
-- keeps the row and clears that link. Deleting a batch does not change stock.
-- "Price" on a row is the price per stock unit. A Sell row with a price is
-- not revenue; the Sales page does not read this table.

CREATE TABLE IF NOT EXISTS inventory_transactions (
  id BIGSERIAL PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  reason TEXT NOT NULL,
  quantity NUMERIC NOT NULL CHECK (quantity > 0),
  quantity_change NUMERIC NOT NULL,
  balance_after NUMERIC NOT NULL CHECK (balance_after >= 0),
  unit_price NUMERIC CHECK (unit_price IS NULL OR unit_price >= 0),
  unit_of_measure TEXT,
  note TEXT,
  occurred_on DATE NOT NULL DEFAULT CURRENT_DATE,
  source TEXT NOT NULL DEFAULT 'manual',
  batch_id INTEGER REFERENCES batches(id) ON DELETE SET NULL,
  purchase_lot_id INTEGER REFERENCES purchase_lots(id) ON DELETE SET NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS inventory_transactions_item_idx
  ON inventory_transactions (client_id, item_id, occurred_on DESC, id DESC);
