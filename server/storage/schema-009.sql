CREATE TABLE IF NOT EXISTS patch_monitor (
 id VARCHAR(32) PRIMARY KEY,
 state JSON NOT NULL
);
CREATE TABLE IF NOT EXISTS patch_articles (
 id CHAR(64) PRIMARY KEY,
 url VARCHAR(512) NOT NULL,
 locale VARCHAR(16) NOT NULL,
 patch VARCHAR(32) NOT NULL,
 title VARCHAR(255) NOT NULL,
 published_at VARCHAR(40) NOT NULL,
 fetched_at BIGINT NOT NULL,
 content_hash CHAR(64) NOT NULL,
 payload JSON NOT NULL,
 UNIQUE KEY patch_revision (url,content_hash)
);
