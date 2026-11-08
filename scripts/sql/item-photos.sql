-- Item photos. Do not run until Luna approves.
-- Safe to run more than once. Existing item rows stay unchanged (new columns are null).
-- The file itself lives in Cloudinary as an authenticated asset. These columns
-- only remember that asset so the API can sign a view URL and delete it later.

ALTER TABLE items ADD COLUMN IF NOT EXISTS image_public_id TEXT;
ALTER TABLE items ADD COLUMN IF NOT EXISTS image_width INTEGER;
ALTER TABLE items ADD COLUMN IF NOT EXISTS image_height INTEGER;
ALTER TABLE items ADD COLUMN IF NOT EXISTS image_bytes INTEGER;
ALTER TABLE items ADD COLUMN IF NOT EXISTS image_format TEXT;

CREATE INDEX IF NOT EXISTS items_image_public_id_idx
  ON items (image_public_id)
  WHERE image_public_id IS NOT NULL;
