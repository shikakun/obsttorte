CREATE TABLE maintenance_reports_next (
  kind   TEXT PRIMARY KEY CHECK (kind IN ('integrity', 'gc', 'snapshot', 'storage', 'retention', 'expire')),
  ran_at INTEGER NOT NULL,
  ok     INTEGER NOT NULL CHECK (ok IN (0, 1)),
  result TEXT NOT NULL
);

INSERT INTO maintenance_reports_next (kind, ran_at, ok, result)
  SELECT kind, ran_at, ok, result FROM maintenance_reports;

DROP TABLE maintenance_reports;

ALTER TABLE maintenance_reports_next RENAME TO maintenance_reports;
