PRAGMA foreign_keys = ON;
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  artist TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  credit TEXT NOT NULL DEFAULT 'Mixing + mastering',
  position INTEGER NOT NULL DEFAULT 0,
  published INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0, 1)),
  audio_id TEXT,
  artwork_id TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX projects_public ON projects(published, deleted_at, position, created_at);
CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL CHECK (kind IN ('audio', 'artwork')),
  object_key TEXT NOT NULL UNIQUE,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  content_type TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'ready', 'garbage')),
  created_at INTEGER NOT NULL
);
CREATE INDEX assets_project ON assets(project_id);
CREATE INDEX assets_cleanup ON assets(state, created_at);
