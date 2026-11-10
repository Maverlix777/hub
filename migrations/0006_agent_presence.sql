-- Agent presence board: one row per (owner, agent, machine). updated_at is server time in ms.
CREATE TABLE IF NOT EXISTS agent_presence (
  owner TEXT NOT NULL,
  agent TEXT NOT NULL,
  machine TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('working', 'idle', 'blocked', 'done')),
  card TEXT,
  note TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner, agent, machine)
);
CREATE INDEX IF NOT EXISTS agent_presence_updated_at ON agent_presence (updated_at);
