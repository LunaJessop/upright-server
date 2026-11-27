-- Reusable phase lists for a company. Do not run until Luna approves.
-- Safe to run more than once. Does not change item phase lists or recipes.
--
-- A router is a named, ordered copy of phases. Applying one to an item copies
-- those phases onto the item. Later edits to either side stay on that side.
-- Deleting a router removes only the router. Items keep the phases they already
-- copied. v1 stores phases only: no default ingredients or quantities.
--
-- The last statement records which router an item's phase list was copied from.
-- Leave that statement out if that label is not wanted. The API leaves the label
-- blank when the column is not there.

CREATE TABLE IF NOT EXISTS client_routers (
  id SERIAL PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (client_id, name)
);

CREATE TABLE IF NOT EXISTS client_router_phases (
  id SERIAL PRIMARY KEY,
  router_id INTEGER NOT NULL REFERENCES client_routers(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  estimated_minutes INTEGER,
  phase_template_id INTEGER REFERENCES client_router_phase_templates(id) ON DELETE SET NULL,
  UNIQUE (router_id, sequence)
);

CREATE INDEX IF NOT EXISTS client_router_phases_router_idx
  ON client_router_phases (router_id);

ALTER TABLE item_routers
  ADD COLUMN IF NOT EXISTS source_router_id INTEGER REFERENCES client_routers(id) ON DELETE SET NULL;
