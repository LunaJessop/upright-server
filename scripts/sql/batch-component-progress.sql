-- Entered ingredient progress on a batch. Do not run until Luna approves.
-- Additive only. Does not change stock, allocations, or phase status.
-- Existing rows are not rewritten. Safe to run more than once.

CREATE TABLE IF NOT EXISTS batch_component_progress (
  id BIGSERIAL PRIMARY KEY,
  batch_component_id INTEGER NOT NULL REFERENCES batch_components(id) ON DELETE CASCADE,
  batch_phase_id INTEGER REFERENCES batch_phases(id) ON DELETE CASCADE,
  quantity_entered NUMERIC NOT NULL CHECK (quantity_entered >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

-- One entered amount per ingredient allocation and batch step.
-- A null step is the unassigned list, and there can be only one of those.
CREATE UNIQUE INDEX IF NOT EXISTS batch_component_progress_context_uidx
  ON batch_component_progress (batch_component_id, COALESCE(batch_phase_id, 0));
