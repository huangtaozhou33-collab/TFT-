CREATE TABLE IF NOT EXISTS snapshot_patch_assignments (
  release_id CHAR(64) NOT NULL, snapshot_key VARCHAR(180) NOT NULL,
  content_hash CHAR(64) NOT NULL, assigned_patch VARCHAR(24) NOT NULL,
  attribution JSON NOT NULL, updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY(release_id,snapshot_key),
  FOREIGN KEY(release_id,snapshot_key) REFERENCES source_snapshots(release_id,snapshot_key)
) ENGINE=InnoDB;
