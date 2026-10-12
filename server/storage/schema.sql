CREATE TABLE IF NOT EXISTS schema_migrations (
  version INT PRIMARY KEY, checksum CHAR(64) NOT NULL, applied_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS data_releases (
  id CHAR(64) PRIMARY KEY, season INT NOT NULL, source_patch VARCHAR(24) NOT NULL,
  state ENUM('staged','published') NOT NULL DEFAULT 'staged', manifest JSON NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), published_at TIMESTAMP(3) NULL
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS runtime_state (
  id TINYINT PRIMARY KEY, current_patch VARCHAR(24) NOT NULL, active_release CHAR(64) NOT NULL,
  FOREIGN KEY (active_release) REFERENCES data_releases(id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS source_snapshots (
  release_id CHAR(64) NOT NULL, snapshot_key VARCHAR(180) NOT NULL, source_patch VARCHAR(24) NULL,
  evidence_kind VARCHAR(40) NOT NULL, content_hash CHAR(64) NOT NULL, payload JSON NOT NULL,
  PRIMARY KEY(release_id,snapshot_key), FOREIGN KEY(release_id) REFERENCES data_releases(id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS entities (
  release_id CHAR(64) NOT NULL, entity_id VARCHAR(240) NOT NULL, kind VARCHAR(32) NOT NULL,
  name VARCHAR(240) NOT NULL, aliases JSON NOT NULL, payload JSON NOT NULL,
  PRIMARY KEY(release_id,entity_id), INDEX entity_names(release_id,kind,name), FOREIGN KEY(release_id) REFERENCES data_releases(id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS knowledge_documents (
  release_id CHAR(64) NOT NULL, document_id VARCHAR(240) NOT NULL, kind VARCHAR(40) NOT NULL,
  title VARCHAR(500) NOT NULL, source_patch VARCHAR(24) NULL, eligible BOOLEAN NOT NULL,
  review_status VARCHAR(80) NOT NULL, entity_ids JSON NOT NULL, source JSON NOT NULL, payload JSON NOT NULL,
  PRIMARY KEY(release_id,document_id), INDEX knowledge_scope(release_id,eligible,source_patch),
  FOREIGN KEY(release_id) REFERENCES data_releases(id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS knowledge_chunks (
  release_id CHAR(64) NOT NULL, chunk_id VARCHAR(80) NOT NULL, document_id VARCHAR(240) NOT NULL,
  ordinal INT NOT NULL, title VARCHAR(500) NOT NULL, text MEDIUMTEXT NOT NULL,
  source_patch VARCHAR(24) NULL, eligible BOOLEAN NOT NULL, entity_ids JSON NOT NULL,
  content_hash CHAR(64) NOT NULL, payload JSON NOT NULL,
  PRIMARY KEY(release_id,chunk_id), INDEX chunk_scope(release_id,eligible,source_patch),
  FOREIGN KEY(release_id,document_id) REFERENCES knowledge_documents(release_id,document_id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS reward_branches (
  release_id CHAR(64) NOT NULL, document_id VARCHAR(240) NOT NULL, table_no INT NOT NULL, row_no INT NOT NULL,
  condition_text TEXT NOT NULL, probability DECIMAL(12,10) NULL, payload JSON NOT NULL,
  PRIMARY KEY(release_id,document_id,table_no,row_no),
  FOREIGN KEY(release_id,document_id) REFERENCES knowledge_documents(release_id,document_id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS source_capabilities (
  release_id CHAR(64) NOT NULL, source_id VARCHAR(80) NOT NULL, capabilities JSON NOT NULL,
  PRIMARY KEY(release_id,source_id), FOREIGN KEY(release_id) REFERENCES data_releases(id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS index_jobs (
  release_id CHAR(64) NOT NULL, profile_hash CHAR(64) NOT NULL, collection_name VARCHAR(160) NOT NULL,
  state ENUM('pending','running','ready','failed') NOT NULL DEFAULT 'pending', indexed_chunks INT NOT NULL DEFAULT 0,
  profile JSON NOT NULL, error_code VARCHAR(80) NULL, updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY(release_id,profile_hash), FOREIGN KEY(release_id) REFERENCES data_releases(id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS change_log (
  id BIGINT AUTO_INCREMENT PRIMARY KEY, release_id CHAR(64) NOT NULL, kind VARCHAR(40) NOT NULL, detail JSON NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), INDEX changes_release(release_id,id),
  FOREIGN KEY(release_id) REFERENCES data_releases(id)
) ENGINE=InnoDB;
