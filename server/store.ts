import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CommandRecord, LinkMetric, PlatformEvent } from '../src/types.js';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });
const db = new DatabaseSync(path.join(config.dataDir, 'relay-platform.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    node_id TEXT NOT NULL,
    type TEXT NOT NULL,
    severity TEXT NOT NULL,
    title TEXT NOT NULL,
    detail TEXT NOT NULL,
    source TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    test_id TEXT NOT NULL,
    source_node TEXT NOT NULL,
    target_node TEXT NOT NULL,
    payload TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS commands (
    command_id TEXT PRIMARY KEY,
    target TEXT NOT NULL,
    action TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    completed_at TEXT,
    status TEXT NOT NULL,
    error TEXT,
    source TEXT NOT NULL
  );
`);

export function addEvent(event: Omit<PlatformEvent, 'id'>): PlatformEvent {
  const result = db.prepare(`
    INSERT INTO events (timestamp, node_id, type, severity, title, detail, source)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(event.timestamp, event.nodeId, event.type, event.severity, event.title, event.detail, event.source);
  return { ...event, id: Number(result.lastInsertRowid) };
}

export function recentEvents(limit = 30): PlatformEvent[] {
  return db.prepare(`
    SELECT id, timestamp, node_id AS nodeId, type, severity, title, detail, source
    FROM events ORDER BY id DESC LIMIT ?
  `).all(limit) as unknown as PlatformEvent[];
}

export function addMetric(metric: LinkMetric): void {
  db.prepare(`INSERT INTO metrics (timestamp, test_id, source_node, target_node, payload) VALUES (?, ?, ?, ?, ?)`)
    .run(metric.timestamp, metric.testId, metric.sourceNode, metric.targetNode, JSON.stringify(metric));
}

export function addCommand(command: CommandRecord): void {
  db.prepare(`
    INSERT INTO commands (command_id, target, action, sent_at, completed_at, status, error, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(command.commandId, command.target, command.action, command.sentAt, command.completedAt ?? null, command.status, command.error ?? null, command.source);
}

export function updateCommand(commandId: string, status: CommandRecord['status'], error?: string): void {
  db.prepare(`UPDATE commands SET status = ?, completed_at = ?, error = ? WHERE command_id = ?`)
    .run(status, new Date().toISOString(), error ?? null, commandId);
}

export function recentCommands(limit = 10): CommandRecord[] {
  return db.prepare(`
    SELECT command_id AS commandId, target, action, sent_at AS sentAt,
      completed_at AS completedAt, status, error, source
    FROM commands ORDER BY sent_at DESC LIMIT ?
  `).all(limit) as unknown as CommandRecord[];
}
