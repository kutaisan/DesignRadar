/**
 * SQLite Snapshot Store
 * Stores TOON snapshots for diffing between versions
 */

import Database from 'better-sqlite3';

export interface Snapshot {
    fileKey: string;
    version: string;
    fileName: string;
    toonData: string;
    filteredJson: string;
    createdAt: string;
}

export class Store {
    private db: Database.Database;

    constructor(dbPath: string) {
        this.db = new Database(dbPath);
        this.init();
    }

    private init(): void {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_key TEXT NOT NULL,
        version TEXT NOT NULL,
        file_name TEXT NOT NULL,
        toon_data TEXT NOT NULL,
        filtered_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(file_key, version)
      );

      CREATE TABLE IF NOT EXISTS tracked_files (
        file_key TEXT PRIMARY KEY,
        file_name TEXT,
        last_version TEXT,
        last_checked_at TEXT,
        channel_webhook TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_snapshots_file_key ON snapshots(file_key);
      CREATE INDEX IF NOT EXISTS idx_snapshots_created ON snapshots(created_at);
    `);
    }

    // ─── Snapshots ───

    saveSnapshot(fileKey: string, version: string, fileName: string, toonData: string, filteredJson: string): void {
        this.db.prepare(`
      INSERT OR REPLACE INTO snapshots (file_key, version, file_name, toon_data, filtered_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(fileKey, version, fileName, toonData, filteredJson);
    }

    getLatestSnapshot(fileKey: string): Snapshot | undefined {
        const row = this.db.prepare(`
      SELECT file_key as fileKey, version, file_name as fileName,
             toon_data as toonData, filtered_json as filteredJson,
             created_at as createdAt
      FROM snapshots
      WHERE file_key = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(fileKey) as Snapshot | undefined;

        return row;
    }

    // ─── Tracked Files ───

    getLastVersion(fileKey: string): string | undefined {
        const row = this.db.prepare(
            'SELECT last_version FROM tracked_files WHERE file_key = ?'
        ).get(fileKey) as { last_version: string } | undefined;
        return row?.last_version;
    }

    updateTrackedFile(fileKey: string, fileName: string, version: string): void {
        this.db.prepare(`
      INSERT INTO tracked_files (file_key, file_name, last_version, last_checked_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(file_key)
      DO UPDATE SET file_name = ?, last_version = ?, last_checked_at = datetime('now')
    `).run(fileKey, fileName, version, fileName, version);
    }

    // ─── Cleanup ───

    cleanOldSnapshots(fileKey: string, keepCount: number = 10): void {
        this.db.prepare(`
      DELETE FROM snapshots
      WHERE file_key = ? AND id NOT IN (
        SELECT id FROM snapshots WHERE file_key = ?
        ORDER BY created_at DESC LIMIT ?
      )
    `).run(fileKey, fileKey, keepCount);
    }

    close(): void {
        this.db.close();
    }
}
