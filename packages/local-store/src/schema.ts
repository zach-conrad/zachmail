import { SPLIT_RULES_DROP, SPLIT_RULES_SCHEMA } from './splitRules'

/** Bump when the client schema changes; the replica is dropped and bootstrapped again. */
export const SCHEMA_VERSION = 3

export const SCHEMA = /* sql */ `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  snippet TEXT NOT NULL,
  participants TEXT NOT NULL,
  last_message_at INTEGER NOT NULL,
  message_count INTEGER NOT NULL,
  unread INTEGER NOT NULL,
  starred INTEGER NOT NULL,
  has_attachments INTEGER NOT NULL,
  folder_ids TEXT NOT NULL,
  split TEXT,
  -- The server's {folderIds, unread, starred} while pending ops overlay this row, else NULL.
  srv TEXT
);
CREATE INDEX IF NOT EXISTS threads_split ON threads (split, last_message_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  date INTEGER NOT NULL,
  unread INTEGER NOT NULL,
  list_unsubscribe INTEGER NOT NULL,
  from_email TEXT,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_thread ON messages (thread_id, date);
-- Triage ops applied locally and not yet settled by the server, in the order they were made.
CREATE TABLE IF NOT EXISTS pending_ops (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  envelope TEXT NOT NULL,
  sent INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS bodies (
  message_id TEXT PRIMARY KEY,
  html TEXT NOT NULL,
  has_remote_images INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL
);
${SPLIT_RULES_SCHEMA}`

export const DROP_ALL = /* sql */ `
DROP TABLE IF EXISTS meta;
DROP TABLE IF EXISTS accounts;
DROP TABLE IF EXISTS folders;
DROP TABLE IF EXISTS threads;
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS bodies;
DROP TABLE IF EXISTS pending_ops;
${SPLIT_RULES_DROP}`
