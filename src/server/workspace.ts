import { ComputerStore } from './computer-store.js';
import { Pages } from './pages.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateLearningSettings } from '../shared/learning.js';
import {
  isIntelligenceThreadId,
  toIntelligenceThreadId,
} from './channel-thread.js';
import type {
  CallReceipt,
  Conversation,
  ConversationSurface,
  Dot,
  Space,
} from '../shared/types.js';

/** Legacy channel bind titles used before surface was stored explicitly. */
const LEGACY_CHANNEL_TITLES = new Set([
  'Slack conversation',
  'Channel conversation',
  'Discord conversation',
]);

/** Tables that store thread_bindings.id as a foreign key. */
const THREAD_ID_TABLES = [
  ['calls', 'threadId'],
  ['captures', 'threadId'],
  ['task_threads', 'threadId'],
] as const;

export class WorkspaceStore {
  private db: DatabaseSync;
  readonly pages: Pages;
  readonly computers: ComputerStore;
  constructor(
    path: string,
    readonly ownerId: string,
  ) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS spaces(id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS dots(id TEXT PRIMARY KEY, spaceId TEXT NOT NULL, name TEXT NOT NULL, instructions TEXT NOT NULL, researchAllowed INTEGER NOT NULL, memoryAllowed INTEGER NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS thread_bindings(id TEXT PRIMARY KEY, dotId TEXT NOT NULL, ownerId TEXT NOT NULL, title TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS task_threads(taskId TEXT PRIMARY KEY, threadId TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS calls(id TEXT PRIMARY KEY, threadId TEXT NOT NULL, startedAt INTEGER NOT NULL, endedAt INTEGER, status TEXT NOT NULL, transcript TEXT NOT NULL, error TEXT);
      CREATE TABLE IF NOT EXISTS captures(threadId TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    for (const [table, column, definition] of [
      ['dots', 'learningContainerId', 'TEXT'],
      ['dots', 'skillDeliveryEnabled', 'INTEGER NOT NULL DEFAULT 0'],
      ['thread_bindings', 'learningContainerId', 'TEXT'],
      // Default web keeps pre-surface rows openable until legacy title backfill below.
      ['thread_bindings', 'surface', "TEXT NOT NULL DEFAULT 'web'"],
      ['thread_bindings', 'channelKey', 'TEXT'],
    ]) {
      if (
        !this.db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .some((field) => field.name === column)
      )
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
    // One-time title heuristic: only known channel bind strings → surface=channel.
    // Prefer the surface column for all new rows; do not infer from id shape alone.
    this.db
      .prepare(
        `UPDATE thread_bindings SET surface='channel'
         WHERE surface='web' AND title IN (${[...LEGACY_CHANNEL_TITLES].map(() => '?').join(', ')})`,
      )
      .run(...LEGACY_CHANNEL_TITLES);
    this.migrateChannelThreadIds();
    // Migrate only once: restarting must never restore a revoked grant.
    if (
      !this.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='dot_spaces'",
        )
        .get()
    ) {
      this.db.exec(`BEGIN;
        CREATE TABLE dot_spaces(dotId TEXT NOT NULL, spaceId TEXT NOT NULL, PRIMARY KEY(dotId, spaceId));
        INSERT INTO dot_spaces SELECT id, spaceId FROM dots;
        COMMIT;`);
    }
    this.computers = new ComputerStore(this.db);
    this.pages = new Pages(this.db, (id) =>
      this.spaces().some((space) => space.id === id),
    );
    if (
      !this.db
        .prepare('PRAGMA table_info(calls)')
        .all()
        .some((column) => column.name === 'anchorMessageId')
    )
      this.db.exec('ALTER TABLE calls ADD COLUMN anchorMessageId TEXT');
    if (!this.spaces().length) {
      const space = this.createSpace(
        'Everyday',
        'A little space for your day.',
      );
      this.createDot(
        space.id,
        'Dot',
        'Be thoughtful, practical, and concise. Help the user think clearly and follow through.',
        true,
        true,
      );
    }
  }
  close() {
    this.db.close();
  }
  spaces(): Space[] {
    return this.db
      .prepare('SELECT * FROM spaces ORDER BY createdAt')
      .all() as unknown as Space[];
  }
  createSpace(name: string, description: string): Space {
    const space = {
      id: randomUUID(),
      name,
      description,
      createdAt: Date.now(),
    };
    this.db
      .prepare('INSERT INTO spaces VALUES (?, ?, ?, ?)')
      .run(space.id, name, description, space.createdAt);
    return space;
  }
  dots(): Dot[] {
    return this.db
      .prepare('SELECT * FROM dots ORDER BY createdAt')
      .all()
      .map((row) => ({
        ...row,
        spaceIds: this.db
          .prepare(
            'SELECT spaceId FROM dot_spaces WHERE dotId=? ORDER BY spaceId',
          )
          .all(String(row.id))
          .map((grant) => String(grant.spaceId)),
        researchAllowed: !!row.researchAllowed,
        memoryAllowed: !!row.memoryAllowed,
        skillDeliveryEnabled: !!row.skillDeliveryEnabled,
      })) as unknown as Dot[];
  }
  dot(id: string) {
    return this.dots().find((dot) => dot.id === id);
  }
  createDot(
    spaceId: string,
    name: string,
    instructions: string,
    researchAllowed: boolean,
    memoryAllowed: boolean,
    spaceIds: string[] = [spaceId],
    learningContainerId: string | null = null,
    skillDeliveryEnabled = false,
  ): Dot {
    this.validateSpaceAccess(spaceId, spaceIds);
    validateLearningSettings(learningContainerId, skillDeliveryEnabled);
    const dot: Dot = {
      id: randomUUID(),
      spaceId,
      spaceIds: [...new Set(spaceIds)].sort(),
      name,
      instructions,
      researchAllowed,
      memoryAllowed,
      learningContainerId,
      skillDeliveryEnabled,
      createdAt: Date.now(),
    };
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          'INSERT INTO dots (id, spaceId, name, instructions, researchAllowed, memoryAllowed, createdAt, learningContainerId, skillDeliveryEnabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          dot.id,
          spaceId,
          name,
          instructions,
          +researchAllowed,
          +memoryAllowed,
          dot.createdAt,
          learningContainerId,
          +skillDeliveryEnabled,
        );
      for (const id of dot.spaceIds)
        this.db.prepare('INSERT INTO dot_spaces VALUES (?, ?)').run(dot.id, id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return dot;
  }
  canAccessSpace(dotId: string, spaceId: string) {
    return !!this.db
      .prepare('SELECT 1 FROM dot_spaces WHERE dotId=? AND spaceId=?')
      .get(dotId, spaceId);
  }
  private validateSpaceAccess(defaultSpace: string, spaceIds: string[]) {
    if (
      !spaceIds.includes(defaultSpace) ||
      spaceIds.some((id) => !this.spaces().some((space) => space.id === id))
    )
      throw new Error('Space access must include a valid default destination.');
  }
  updateDot(
    id: string,
    patch: Pick<
      Dot,
      'name' | 'instructions' | 'researchAllowed' | 'memoryAllowed'
    > & {
      spaceId?: string;
      spaceIds?: string[];
      learningContainerId?: string | null;
      skillDeliveryEnabled?: boolean;
    },
  ): Dot {
    const current = this.dot(id);
    if (!current) throw new Error('Dot not found.');
    const defaultSpace = patch.spaceId ?? current.spaceId;
    const spaceIds = patch.spaceIds ?? current.spaceIds;
    this.validateSpaceAccess(defaultSpace, spaceIds);
    const learningContainerId =
      patch.learningContainerId === undefined
        ? (current.learningContainerId ?? null)
        : patch.learningContainerId;
    const skillDeliveryEnabled =
      patch.skillDeliveryEnabled ?? current.skillDeliveryEnabled ?? false;
    validateLearningSettings(learningContainerId, skillDeliveryEnabled);
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          'UPDATE dots SET name=?, instructions=?, researchAllowed=?, memoryAllowed=?, learningContainerId=?, skillDeliveryEnabled=? WHERE id=?',
        )
        .run(
          patch.name,
          patch.instructions,
          +patch.researchAllowed,
          +patch.memoryAllowed,
          learningContainerId,
          +skillDeliveryEnabled,
          id,
        );
      this.db
        .prepare('UPDATE dots SET spaceId=? WHERE id=?')
        .run(defaultSpace, id);
      this.db.prepare('DELETE FROM dot_spaces WHERE dotId=?').run(id);
      for (const space of new Set(spaceIds))
        this.db.prepare('INSERT INTO dot_spaces VALUES (?, ?)').run(id, space);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.dot(id)!;
  }
  /** All owner thread bindings (web, page, and channel). Channel rows use
   * Intelligence-compatible UUID ids; see `channelKey` for the external key. */
  conversations(): Conversation[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM thread_bindings WHERE ownerId=? ORDER BY createdAt DESC',
        )
        .all(this.ownerId) as Array<Record<string, unknown>>
    ).map((row) => this.mapConversation(row));
  }
  bindThread(
    id: string,
    dotId: string,
    title: string,
    surface: ConversationSurface = 'web',
    channelKey: string | null = null,
  ): Conversation {
    const dot = this.dot(dotId);
    if (!dot) throw new Error('Dot not found.');
    const value: Conversation = {
      id,
      dotId,
      ownerId: this.ownerId,
      title,
      createdAt: Date.now(),
      learningContainerId: dot.learningContainerId ?? null,
      surface,
      channelKey,
    };
    this.db
      .prepare(
        'INSERT INTO thread_bindings (id, dotId, ownerId, title, createdAt, learningContainerId, surface, channelKey) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        dotId,
        this.ownerId,
        title,
        value.createdAt,
        value.learningContainerId ?? null,
        surface,
        channelKey,
      );
    return value;
  }
  /**
   * Bind a Channels conversation under an Intelligence-compatible UUID.
   * `channelThreadId` may be a Discord snowflake or other non-UUID key; the
   * returned conversation `.id` is always a UUID suitable for web connect.
   */
  bindChannelThread(
    channelThreadId: string,
    dotId: string,
    title: string,
  ): Conversation {
    const id = toIntelligenceThreadId(channelThreadId);
    const channelKey = id === channelThreadId ? null : channelThreadId;
    const existing = this.findThread(channelThreadId);
    if (existing) {
      if (existing.id !== id)
        this.rewriteThreadPrimaryKey(
          existing.id,
          id,
          channelKey ?? existing.id,
        );
      if (this.requireThread(id).title !== title)
        return this.setThreadTitle(id, title);
      return this.requireThread(id);
    }
    return this.bindThread(id, dotId, title, 'channel', channelKey);
  }
  /** Correct a channel bind title once the provider-specific agent runs. */
  setThreadTitle(id: string, title: string): Conversation {
    const thread = this.requireThread(id);
    if (thread.title === title) return thread;
    this.db
      .prepare('UPDATE thread_bindings SET title=? WHERE id=? AND ownerId=?')
      .run(title, id, this.ownerId);
    return { ...thread, title };
  }
  findThread(idOrChannelKey: string): Conversation | undefined {
    const intelligenceId = toIntelligenceThreadId(idOrChannelKey);
    return this.conversations().find(
      (thread) =>
        thread.id === idOrChannelKey ||
        thread.id === intelligenceId ||
        thread.channelKey === idOrChannelKey,
    );
  }
  requireThread(id: string, dotId?: string): Conversation {
    const thread = this.findThread(id);
    if (!thread || (dotId && thread.dotId !== dotId))
      throw new Error('Conversation does not belong to this Dot and owner.');
    return thread;
  }
  private mapConversation(row: Record<string, unknown>): Conversation {
    const surface =
      row.surface === 'channel' || row.surface === 'page' ? row.surface : 'web';
    return {
      id: String(row.id),
      dotId: String(row.dotId),
      ownerId: String(row.ownerId),
      title: String(row.title),
      createdAt: Number(row.createdAt),
      learningContainerId:
        typeof row.learningContainerId === 'string'
          ? row.learningContainerId
          : null,
      surface,
      channelKey: typeof row.channelKey === 'string' ? row.channelKey : null,
    };
  }
  /**
   * Rewrite legacy channel bindings that stored Discord snowflakes (or other
   * non-UUID keys) as the primary key into Intelligence UUID ids + channelKey.
   */
  private migrateChannelThreadIds() {
    const rows = this.db
      .prepare(
        'SELECT id, surface, channelKey FROM thread_bindings WHERE ownerId=?',
      )
      .all(this.ownerId) as Array<{
      id: string;
      surface: string;
      channelKey: string | null;
    }>;
    for (const row of rows) {
      if (isIntelligenceThreadId(row.id)) continue;
      // Only remap known channel rows (or rows that still carry a channel title).
      if (row.surface !== 'channel' && !row.channelKey) continue;
      const nextId = toIntelligenceThreadId(row.id);
      if (nextId === row.id) continue;
      this.rewriteThreadPrimaryKey(row.id, nextId, row.channelKey ?? row.id);
    }
  }
  private rewriteThreadPrimaryKey(
    fromId: string,
    toId: string,
    channelKey: string,
  ) {
    this.db.exec('BEGIN');
    try {
      const current = this.db
        .prepare('SELECT * FROM thread_bindings WHERE id=?')
        .get(fromId) as Record<string, unknown> | undefined;
      if (!current) {
        this.db.exec('ROLLBACK');
        return;
      }
      const clash = this.db
        .prepare('SELECT id FROM thread_bindings WHERE id=?')
        .get(toId);
      if (clash) {
        this.db.prepare('DELETE FROM thread_bindings WHERE id=?').run(fromId);
      } else {
        this.db
          .prepare(
            `INSERT INTO thread_bindings
              (id, dotId, ownerId, title, createdAt, learningContainerId, surface, channelKey)
             VALUES (?, ?, ?, ?, ?, ?, 'channel', ?)`,
          )
          .run(
            toId,
            String(current.dotId),
            String(current.ownerId),
            String(current.title),
            Number(current.createdAt),
            typeof current.learningContainerId === 'string'
              ? current.learningContainerId
              : null,
            channelKey,
          );
        this.db.prepare('DELETE FROM thread_bindings WHERE id=?').run(fromId);
      }
      for (const [table, column] of THREAD_ID_TABLES) {
        this.db
          .prepare(`UPDATE ${table} SET ${column}=? WHERE ${column}=?`)
          .run(toId, fromId);
      }
      if (
        this.db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='page_threads'",
          )
          .get()
      )
        this.db
          .prepare('UPDATE page_threads SET threadId=? WHERE threadId=?')
          .run(toId, fromId);
      if (
        this.db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='page_reviews'",
          )
          .get()
      )
        this.db
          .prepare('UPDATE page_reviews SET threadId=? WHERE threadId=?')
          .run(toId, fromId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  bindTask(taskId: string, threadId: string) {
    this.requireThread(threadId);
    this.db
      .prepare('INSERT INTO task_threads VALUES (?, ?)')
      .run(taskId, threadId);
  }
  taskThread(taskId: string): string | undefined {
    const row = this.db
      .prepare('SELECT threadId FROM task_threads WHERE taskId=?')
      .get(taskId);
    return typeof row?.threadId === 'string' ? row.threadId : undefined;
  }
  calls(threadId?: string): CallReceipt[] {
    if (threadId) this.requireThread(threadId);
    return this.db
      .prepare(
        `SELECT * FROM calls ${threadId ? 'WHERE threadId=?' : ''} ORDER BY startedAt DESC`,
      )
      .all(...(threadId ? [threadId] : [])) as unknown as CallReceipt[];
  }
  createCall(threadId: string): CallReceipt {
    this.requireThread(threadId);
    const call: CallReceipt = {
      id: randomUUID(),
      threadId,
      startedAt: Date.now(),
      endedAt: null,
      status: 'connecting',
      transcript: '',
      error: null,
    };
    this.db
      .prepare(
        'INSERT INTO calls(id, threadId, startedAt, endedAt, status, transcript, error) VALUES (?, ?, ?, NULL, ?, ?, NULL)',
      )
      .run(call.id, threadId, call.startedAt, call.status, '');
    return call;
  }
  call(id: string): CallReceipt {
    const call = this.calls().find((call) => call.id === id);
    if (!call) throw new Error('Call not found.');
    this.requireThread(call.threadId);
    return call;
  }
  setCall(
    id: string,
    status: CallReceipt['status'],
    transcript: string,
    error: string | null = null,
  ) {
    const call = this.call(id);
    if (call.endedAt) return call;
    this.db
      .prepare(
        'UPDATE calls SET status=?, transcript=?, error=?, endedAt=? WHERE id=?',
      )
      .run(
        status,
        transcript,
        error,
        status === 'ended' || status === 'failed' ? Date.now() : null,
        id,
      );
    return this.call(id);
  }
  saveLateTranscript(id: string, transcript: string) {
    this.call(id);
    return (
      this.db
        .prepare(
          "UPDATE calls SET transcript=? WHERE id=? AND transcript='' AND endedAt IS NOT NULL",
        )
        .run(transcript, id).changes > 0
    );
  }
  anchorCall(id: string, anchor: string | undefined) {
    this.call(id);
    this.db
      .prepare('UPDATE calls SET anchorMessageId=? WHERE id=?')
      .run(anchor ?? null, id);
  }
  setCallError(id: string, error: string | null) {
    this.call(id);
    this.db.prepare('UPDATE calls SET error=? WHERE id=?').run(error, id);
  }
  saveCapture(threadId: string, value: unknown) {
    this.requireThread(threadId);
    this.db
      .prepare(
        'INSERT INTO captures VALUES (?, ?) ON CONFLICT(threadId) DO UPDATE SET value=excluded.value',
      )
      .run(threadId, JSON.stringify(value));
  }
  capture(threadId: string): unknown {
    this.requireThread(threadId);
    const row = this.db
      .prepare('SELECT value FROM captures WHERE threadId=?')
      .get(threadId);
    return typeof row?.value === 'string' ? JSON.parse(row.value) : null;
  }
}
