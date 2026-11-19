-- Daily insights and coaching: one report per user per reviewed log date. The digest holds the
-- numbers the model was given; the report is what it wrote. `partial` marks a "so far today"
-- report made by hand, which the nightly run replaces once the day is over.
CREATE TABLE coach_report (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id),
  log_date        TEXT NOT NULL,
  partial         INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  model           TEXT,
  prompt_version  TEXT,
  digest_json     TEXT,
  report_json     TEXT,
  error           TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (user_id, log_date)
);
