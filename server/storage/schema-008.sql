CREATE TABLE IF NOT EXISTS statistics_jobs (
  id VARCHAR(48) PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  interval_hours INT NOT NULL DEFAULT 24,
  next_run_at BIGINT NOT NULL,
  last_started_at BIGINT NULL,
  last_finished_at BIGINT NULL,
  last_success_at BIGINT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'scheduled',
  progress JSON NULL,
  revision INT NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS statistics_job_runs (
  id CHAR(36) PRIMARY KEY,
  job_id VARCHAR(48) NOT NULL,
  started_at BIGINT NOT NULL,
  finished_at BIGINT NULL,
  status VARCHAR(24) NOT NULL,
  report JSON NULL,
  INDEX runs_job_time(job_id, started_at),
  FOREIGN KEY (job_id) REFERENCES statistics_jobs(id)
);
CREATE TABLE IF NOT EXISTS statistics_reference_snapshots (
  id CHAR(64) PRIMARY KEY,
  release_id CHAR(64) NOT NULL,
  source VARCHAR(24) NOT NULL,
  query_key CHAR(64) NOT NULL,
  query_scope JSON NOT NULL,
  raw_response LONGTEXT NOT NULL,
  content_hash CHAR(64) NOT NULL,
  captured_at BIGINT NOT NULL,
  checked_at BIGINT NOT NULL,
  INDEX reference_query(release_id, query_key, checked_at)
);
