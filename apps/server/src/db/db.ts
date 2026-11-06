import Database from "better-sqlite3";
import { SCHEMA } from "./schema";

export type DB = Database.Database;

/** Open (or create) a SQLite database and make sure all tables exist.
 *  Use ":memory:" for tests and demos. */
export function openDb(path: string): DB {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}
