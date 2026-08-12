CREATE TABLE subscriptions (
  id            TEXT PRIMARY KEY,
  tier          TEXT NOT NULL,
  seats         INTEGER NOT NULL,
  monthly_cents INTEGER NOT NULL
);
