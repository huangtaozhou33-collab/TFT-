CREATE TABLE IF NOT EXISTS riot_matches (
  match_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  platform VARCHAR(16) NOT NULL, region VARCHAR(16) NOT NULL, queue_id INT NULL, season INT NULL,
  game_started_at BIGINT NULL, game_ended_at BIGINT NULL, raw_game_version VARCHAR(240) NULL,
  source_patch VARCHAR(24) NULL, assigned_patch VARCHAR(24) NULL, patch_attribution JSON NULL,
  status VARCHAR(32) NOT NULL, content_hash CHAR(64) NOT NULL, quality JSON NOT NULL, raw_payload JSON NOT NULL,
  fetched_at BIGINT NOT NULL, ingested_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX riot_match_scope(status,season,assigned_patch,queue_id), INDEX riot_match_time(game_ended_at)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS riot_participants (
  match_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, participant_index INT NOT NULL,
  placement INT NOT NULL, level INT NULL, composition_key CHAR(64) NOT NULL, units_json JSON NOT NULL, traits_json JSON NOT NULL,
  PRIMARY KEY(match_id,participant_index), INDEX riot_composition(composition_key),
  FOREIGN KEY(match_id) REFERENCES riot_matches(match_id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS riot_units (
  match_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, participant_index INT NOT NULL, unit_index INT NOT NULL,
  champion_id VARCHAR(240) COLLATE utf8mb4_bin NOT NULL, star_level INT NOT NULL, item_ids JSON NOT NULL,
  build_key CHAR(64) NOT NULL, valid_build BOOLEAN NOT NULL,
  PRIMARY KEY(match_id,participant_index,unit_index), INDEX riot_champion(champion_id,match_id,participant_index),
  FOREIGN KEY(match_id,participant_index) REFERENCES riot_participants(match_id,participant_index)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS riot_unit_items (
  match_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, participant_index INT NOT NULL, unit_index INT NOT NULL,
  item_index INT NOT NULL, item_id VARCHAR(240) COLLATE utf8mb4_bin NOT NULL,
  PRIMARY KEY(match_id,participant_index,unit_index,item_index), INDEX riot_item(item_id,match_id,participant_index),
  FOREIGN KEY(match_id,participant_index,unit_index) REFERENCES riot_units(match_id,participant_index,unit_index)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS riot_traits (
  match_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, participant_index INT NOT NULL,
  trait_id VARCHAR(240) COLLATE utf8mb4_bin NOT NULL, style INT NOT NULL, tier_current INT NOT NULL,
  PRIMARY KEY(match_id,participant_index,trait_id), INDEX riot_trait(trait_id,style,match_id,participant_index),
  FOREIGN KEY(match_id,participant_index) REFERENCES riot_participants(match_id,participant_index)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS riot_collection_jobs (
  job_key VARCHAR(160) PRIMARY KEY, payload JSON NOT NULL,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;
