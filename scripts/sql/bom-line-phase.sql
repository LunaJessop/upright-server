-- Link a recipe line to the company phase where that material is used.
-- Paste this into the Neon SQL Editor. Safe to run more than once.
-- Does not change rows that are already stored.

ALTER TABLE bom_items
  ADD COLUMN IF NOT EXISTS phase_id INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'bom_items_phase_id_fkey'
  ) THEN
    ALTER TABLE bom_items
      ADD CONSTRAINT bom_items_phase_id_fkey
      FOREIGN KEY (phase_id)
      REFERENCES client_router_phase_templates(id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS bom_items_phase_id_idx
  ON bom_items (phase_id);
