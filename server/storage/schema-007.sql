CREATE TABLE IF NOT EXISTS metatft_datasets (
  id CHAR(64) PRIMARY KEY,
  release_id CHAR(64) NOT NULL,
  dataset_key CHAR(64) NOT NULL,
  kind VARCHAR(24) NOT NULL,
  entity_id VARCHAR(240) NOT NULL,
  query_scope JSON NOT NULL,
  source_metadata JSON NOT NULL,
  raw_response_text LONGTEXT NOT NULL,
  content_hash CHAR(64) NOT NULL,
  summary JSON NOT NULL,
  captured_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  INDEX metatft_dataset_lookup(release_id,dataset_key,captured_at),
  FOREIGN KEY(release_id) REFERENCES data_releases(id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS metatft_dataset_rows (
  dataset_id CHAR(64) NOT NULL,
  dimension VARCHAR(24) NOT NULL,
  row_key CHAR(64) NOT NULL,
  entity_id VARCHAR(240) NOT NULL,
  sample_size BIGINT NOT NULL,
  avg_placement DOUBLE NOT NULL,
  placement_count JSON NOT NULL,
  payload JSON NOT NULL,
  PRIMARY KEY(dataset_id,dimension,row_key),
  INDEX metatft_dataset_entity(dataset_id,dimension,entity_id),
  FOREIGN KEY(dataset_id) REFERENCES metatft_datasets(id)
) ENGINE=InnoDB;
