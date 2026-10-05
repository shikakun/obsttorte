CREATE TABLE counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
INSERT INTO counters (name, value) VALUES ('seq', 0), ('maintenance', 0);

CREATE TABLE devices (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  token_hash       TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  revoked_at       INTEGER,
  last_seen_at     INTEGER,
  last_api_version INTEGER
);
CREATE UNIQUE INDEX idx_devices_token_hash ON devices (token_hash);

CREATE TABLE objects (
  sha256             TEXT PRIMARY KEY,
  size               INTEGER NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('pending', 'verified')),
  created_at         INTEGER NOT NULL,
  last_referenced_at INTEGER NOT NULL
);

CREATE TABLE files (
  path       TEXT PRIMARY KEY,
  path_key   TEXT NOT NULL,
  sha256     TEXT,
  size       INTEGER NOT NULL DEFAULT 0,
  rev        INTEGER NOT NULL,
  seq        INTEGER NOT NULL,
  deleted    INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  updated_at INTEGER NOT NULL,
  device     TEXT NOT NULL,
  request_id TEXT NOT NULL,
  CHECK ((deleted = 1 AND sha256 IS NULL) OR (deleted = 0 AND sha256 IS NOT NULL))
);
CREATE INDEX idx_files_seq ON files (seq);
CREATE INDEX idx_files_sha ON files (sha256);
CREATE UNIQUE INDEX idx_files_live_path_key ON files (path_key) WHERE deleted = 0;

CREATE TABLE history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  path       TEXT NOT NULL,
  sha256     TEXT,
  size       INTEGER NOT NULL,
  rev        INTEGER NOT NULL,
  seq        INTEGER NOT NULL,
  deleted    INTEGER NOT NULL,
  changed_at INTEGER NOT NULL,
  device     TEXT NOT NULL,
  request_id TEXT NOT NULL
);
CREATE INDEX idx_history_path ON history (path, rev DESC);
CREATE INDEX idx_history_sha ON history (sha256);
CREATE INDEX idx_history_request ON history (request_id);

CREATE TABLE conflicts (
  id           TEXT PRIMARY KEY,
  path         TEXT NOT NULL,
  base_sha     TEXT,
  local_sha    TEXT NOT NULL,
  remote_sha   TEXT NOT NULL,
  device       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  resolved_at  INTEGER,
  resolved_sha TEXT
);

CREATE TABLE requests (
  id         TEXT PRIMARY KEY,
  device     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  response   TEXT
);
CREATE INDEX idx_requests_created ON requests (created_at);

CREATE TABLE gc_candidates (
  sha256    TEXT PRIMARY KEY,
  marked_at INTEGER NOT NULL
);

CREATE TABLE purge_tokens (
  token_hash TEXT PRIMARY KEY,
  device     TEXT NOT NULL,
  target     TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE maintenance_reports (
  kind   TEXT PRIMARY KEY CHECK (kind IN ('integrity', 'gc', 'snapshot', 'storage')),
  ran_at INTEGER NOT NULL,
  ok     INTEGER NOT NULL CHECK (ok IN (0, 1)),
  result TEXT NOT NULL
);
