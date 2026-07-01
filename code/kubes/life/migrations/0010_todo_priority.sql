-- Optional priority (high/medium/low) on a to-do, so the list can triage the way
-- the dicom-scan case file does. NULL = unprioritised (sorts last).
ALTER TABLE todos ADD COLUMN IF NOT EXISTS priority VARCHAR(8) NULL;
