-- life schema, migration 0011: restorable deletion for the REST entities.
-- items/locations/recipes previously hard-DELETEd; now they tombstone
-- (deleted_at) like the synced tables, so anything the user deletes can be
-- restored from the trash screen. Nothing is ever purged.
ALTER TABLE items     ADD COLUMN IF NOT EXISTS deleted_at DATETIME NULL;
ALTER TABLE locations ADD COLUMN IF NOT EXISTS deleted_at DATETIME NULL;
ALTER TABLE recipes   ADD COLUMN IF NOT EXISTS deleted_at DATETIME NULL;
