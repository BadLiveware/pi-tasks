/**
 * task-store.ts — File-backed task store with CRUD, dependency management, and file locking.
 *
 * Session-scoped (default): in-memory Map — no disk I/O.
 * Shared (PI_TASK_LIST_ID set): ~/.pi/tasks/<listId>.json with file locking.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { sortTasks, type TaskSortOrder } from "./task-sort.js";
import type {
  Task,
  TaskCreateInput,
  TaskCreateManyResult,
  TaskMutationResult,
  TaskRelation,
  TaskStoreData,
  TaskUpdateFields,
  TaskUpdateManyResult,
} from "./types.js";

const TASKS_DIR = join(homedir(), ".pi", "tasks");
const LOCK_RETRY_MS = 50;
const LOCK_MAX_RETRIES = 100; // 5s max

/**
 * Simple file-based locking. Returns the token written into the lock file, which
 * must be handed back to `releaseLock`.
 *
 * The token is `<pid>:<uuid>`: the PID prefix is what the staleness check below
 * parses, and the UUID suffix makes it unique so a holder can tell its own lock
 * from a successor's. Both halves matter — see `releaseLock`.
 */
function acquireLock(lockPath: string): string {
  mkdirSync(dirname(lockPath), { recursive: true });
  const token = `${process.pid}:${randomUUID()}`;

  for (let i = 0; i < LOCK_MAX_RETRIES; i++) {
    try {
      // O_EXCL: fail if file exists
      writeFileSync(lockPath, token, { flag: "wx" });
      return token;
    } catch (e: any) {
      if (e.code === "EEXIST") {
        // Check for stale lock (process no longer running)
        try {
          const pid = parseInt(readFileSync(lockPath, "utf-8"), 10);
          // A lock naming a dead process is stale. So is one with no readable PID,
          // but only after a couple of polls: the file is created before the PID is
          // written to it, so a live acquirer can look unparseable for a moment —
          // one that crashed in that window looks that way forever.
          if (pid > 0 ? !isProcessRunning(pid) : i >= 2) {
            unlinkSync(lockPath);
            continue;
          }
        } catch {
          /* ignore read errors */
        }
        // Wait and retry
        const start = Date.now();
        while (Date.now() - start < LOCK_RETRY_MS) {
          /* busy wait */
        }
        continue;
      }
      throw e;
    }
  }
  throw new Error(`Failed to acquire lock: ${lockPath}`);
}

/**
 * Release a lock, but only if we still hold it. A lock can be reclaimed out from
 * under a live holder — `isProcessRunning` answers from the local process table,
 * so a session in another PID namespace (container, or a list shared over NFS)
 * can read our PID as dead. Without the token check we would then delete the
 * successor's lock and two sessions would write the file at once.
 */
function releaseLock(lockPath: string, token: string): void {
  try {
    if (readFileSync(lockPath, "utf-8") === token) unlinkSync(lockPath);
  } catch { /* ignore — already gone */ }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function relationKey(relation: TaskRelation): string {
  return `${relation.type}\0${relation.target}`;
}

function normalizeRelation(relation: TaskRelation): TaskRelation {
  return { type: relation.type, target: relation.target };
}

/**
 * Fill defaults for tasks persisted by older versions. Task files written
 * before the blocking feature have no `blockedBy`/`blocks`/`metadata`, so
 * consumers that read those fields unguarded (e.g. `task.blockedBy.length`)
 * would throw. Normalizing at the load boundary lets every consumer trust the
 * shape. Also guards against wrong types in hand-edited files.
 */
function normalizeTask(t: Task): Task {
  const now = Date.now();
  let relations: TaskRelation[] = [];
  if (Array.isArray(t.relations)) {
    relations = t.relations.filter(relation =>
      relation && typeof relation.type === "string" && typeof relation.target === "string"
    ).map(normalizeRelation);
  }
  return {
    ...t,
    metadata: t.metadata && typeof t.metadata === "object" && !Array.isArray(t.metadata) ? t.metadata : {},
    blocks: Array.isArray(t.blocks) ? t.blocks : [],
    blockedBy: Array.isArray(t.blockedBy) ? t.blockedBy : [],
    relations,
    createdAt: typeof t.createdAt === "number" ? t.createdAt : now,
    updatedAt: typeof t.updatedAt === "number" ? t.updatedAt : now,
  };
}

export class TaskStore {
  private filePath: string | undefined;
  private lockPath: string | undefined;

  // In-memory state (always kept in sync)
  private nextId = 1;
  private tasks = new Map<string, Task>();

  constructor(listIdOrPath?: string) {
    if (!listIdOrPath) return;
    const isAbsPath = isAbsolute(listIdOrPath);
    const filePath = isAbsPath ? listIdOrPath : join(TASKS_DIR, `${listIdOrPath}.json`);
    // Directory is created lazily on the first write (acquireLock/save both
    // mkdir it), so a session that never persists a task leaves no .pi/tasks/.
    this.filePath = filePath;
    this.lockPath = filePath + ".lock";
    this.load();
  }

  /**
   * Read store from disk (file-backed mode only).
   *
   * `normalizeTask` hardens each record; this hardens the envelope around them.
   * A truncated write, a bad merge or a hand edit can leave a file that parses
   * but has no `tasks` array or no usable `nextId`, and both used to corrupt the
   * store: the missing array threw mid-load and left it wiped, and the missing
   * counter produced the task ID "NaN", then IDs restarting at "0" and colliding
   * with live tasks. Anything unusable now leaves the current state alone.
   */
  private load(): void {
    if (!this.filePath) return;
    if (!existsSync(this.filePath)) return;
    try {
      const data: unknown = JSON.parse(readFileSync(this.filePath, "utf-8"));
      if (!data || typeof data !== "object") return;
      const { nextId, tasks } = data as Partial<TaskStoreData>;
      if (!Array.isArray(tasks)) return;

      // Build the replacement before touching the live state, so a bad record
      // can't leave the store half-loaded.
      const loaded = new Map<string, Task>();
      let maxId = 0;
      for (const t of tasks) {
        if (!t || typeof t !== "object" || typeof t.id !== "string") continue;
        loaded.set(t.id, normalizeTask(t));
        const numericId = Number(t.id);
        if (Number.isFinite(numericId) && numericId > maxId) maxId = numericId;
      }
      this.tasks = loaded;
      // Every future task ID comes from this counter, so it has to clear the IDs
      // already in use — whether the file omitted it or recorded a stale one.
      this.nextId = typeof nextId === "number" && Number.isInteger(nextId) && nextId > maxId ? nextId : maxId + 1;
    } catch { /* unreadable or not JSON — keep the state we have */ }
  }

  /** Write store to disk atomically (file-backed mode only). */
  private save(): void {
    if (!this.filePath) return;
    const data: TaskStoreData = {
      nextId: this.nextId,
      tasks: Array.from(this.tasks.values()),
    };
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmpPath = this.filePath + ".tmp";
    writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    renameSync(tmpPath, this.filePath);
  }

  /** Execute a mutation with file locking (if file-backed). */
  private withLock<T>(fn: () => T, options: { save?: boolean } = {}): T {
    if (!this.lockPath) return fn();
    const token = acquireLock(this.lockPath);
    try {
      this.load(); // Re-read latest state
      const result = fn();
      if (options.save !== false) this.save();
      return result;
    } finally {
      releaseLock(this.lockPath, token);
    }
  }

  private resolveRef(ref: string, keyMap?: Map<string, string>): string {
    return keyMap?.get(ref) ?? ref;
  }

  private addBlockEdge(blockerId: string, blockedId: string, warnings: string[], cycleIds: [string, string] = [blockerId, blockedId]): void {
    const blocker = this.tasks.get(blockerId);
    const blocked = this.tasks.get(blockedId);

    if (blocker && !blocker.blocks.includes(blockedId)) {
      blocker.blocks.push(blockedId);
      blocker.updatedAt = Date.now();
    }
    if (blocked && !blocked.blockedBy.includes(blockerId)) {
      blocked.blockedBy.push(blockerId);
      blocked.updatedAt = Date.now();
    }

    if (blockerId === blockedId) {
      warnings.push(`#${blockerId} blocks itself`);
    } else if (!blocker) {
      warnings.push(`#${blockerId} does not exist`);
    } else if (!blocked) {
      warnings.push(`#${blockedId} does not exist`);
    } else if (blocked.blocks.includes(blockerId)) {
      warnings.push(`cycle: #${cycleIds[0]} and #${cycleIds[1]} block each other`);
    }
  }

  private addRelation(task: Task, relation: TaskRelation, warnings: string[]): void {
    const normalized = normalizeRelation(relation);
    const key = relationKey(normalized);
    if (task.relations.some(existing => relationKey(existing) === key)) return;
    if (!this.tasks.has(normalized.target)) {
      warnings.push(`relation target #${normalized.target} does not exist`);
    }
    task.relations.push(normalized);
    task.updatedAt = Date.now();
  }

  private cleanupReferencesTo(id: string): void {
    for (const t of this.tasks.values()) {
      t.blocks = t.blocks.filter(bid => bid !== id);
      t.blockedBy = t.blockedBy.filter(bid => bid !== id);
      t.relations = t.relations.filter(rel => rel.target !== id);
    }
  }

  private applyUpdate(id: string, fields: TaskUpdateFields): TaskMutationResult {
    const task = this.tasks.get(id);
    if (!task) return { task: undefined, changedFields: [], warnings: [] };

    const changedFields: string[] = [];
    const warnings: string[] = [];

    // Handle deletion
    if (fields.status === "deleted") {
      this.tasks.delete(id);
      this.cleanupReferencesTo(id);
      return { task: undefined, changedFields: ["deleted"], warnings: [] };
    }

    if (fields.status !== undefined) {
      task.status = fields.status;
      changedFields.push("status");
    }
    if (fields.subject !== undefined) {
      task.subject = fields.subject;
      changedFields.push("subject");
    }
    if (fields.description !== undefined) {
      task.description = fields.description;
      changedFields.push("description");
    }
    if (fields.activeForm !== undefined) {
      task.activeForm = fields.activeForm;
      changedFields.push("activeForm");
    }
    if (fields.owner !== undefined) {
      task.owner = fields.owner;
      changedFields.push("owner");
    }

    // Metadata: shallow merge, null deletes keys
    if (fields.metadata !== undefined) {
      for (const [key, value] of Object.entries(fields.metadata)) {
        if (value === null) {
          delete task.metadata[key];
        } else {
          task.metadata[key] = value;
        }
      }
      changedFields.push("metadata");
    }

    // Bidirectional dependency edges
    if (fields.addBlocks && fields.addBlocks.length > 0) {
      for (const targetId of fields.addBlocks) {
        this.addBlockEdge(id, targetId, warnings);
      }
      changedFields.push("blocks");
    }

    if (fields.addBlockedBy && fields.addBlockedBy.length > 0) {
      for (const targetId of fields.addBlockedBy) {
        this.addBlockEdge(targetId, id, warnings, [id, targetId]);
      }
      changedFields.push("blockedBy");
    }

    if (fields.setRelations !== undefined) {
      task.relations = [];
      for (const relation of fields.setRelations) {
        this.addRelation(task, relation, warnings);
      }
      changedFields.push("relations");
    }

    if (fields.addRelations && fields.addRelations.length > 0) {
      for (const relation of fields.addRelations) {
        this.addRelation(task, relation, warnings);
      }
      changedFields.push("relations");
    }

    if (fields.removeRelations && fields.removeRelations.length > 0) {
      const removeKeys = new Set(fields.removeRelations.map(relation => relationKey(normalizeRelation(relation))));
      task.relations = task.relations.filter(relation => !removeKeys.has(relationKey(relation)));
      changedFields.push("relations");
    }

    task.updatedAt = Date.now();
    return { task, changedFields, warnings };
  }

  create(subject: string, description: string, activeForm?: string, metadata?: Record<string, any>): Task {
    const result = this.createMany([{ subject, description, activeForm, metadata }]);
    return result.tasks[0];
  }

  createMany(inputs: TaskCreateInput[]): TaskCreateManyResult {
    return this.withLock(() => {
      const warnings: string[] = [];
      const created: Task[] = [];
      const keyMap = new Map<string, string>();

      for (const input of inputs) {
        const now = Date.now();
        const metadata = { ...(input.metadata ?? {}) };
        if (input.agentType) metadata.agentType = input.agentType;
        const task: Task = {
          id: String(this.nextId++),
          subject: input.subject,
          description: input.description,
          status: input.status ?? "pending",
          activeForm: input.activeForm,
          owner: undefined,
          metadata,
          blocks: [],
          blockedBy: [],
          relations: [],
          createdAt: now,
          updatedAt: now,
        };
        this.tasks.set(task.id, task);
        created.push(task);

        if (input.key) {
          if (keyMap.has(input.key)) {
            warnings.push(`duplicate task key "${input.key}"`);
          } else {
            keyMap.set(input.key, task.id);
          }
        }
      }

      for (let i = 0; i < inputs.length; i++) {
        const input = inputs[i];
        const task = created[i];

        for (const targetRef of input.blocks ?? []) {
          this.addBlockEdge(task.id, this.resolveRef(targetRef, keyMap), warnings);
        }

        for (const targetRef of input.blockedBy ?? []) {
          this.addBlockEdge(this.resolveRef(targetRef, keyMap), task.id, warnings, [task.id, this.resolveRef(targetRef, keyMap)]);
        }

        for (const relation of input.relations ?? []) {
          this.addRelation(task, {
            ...relation,
            target: this.resolveRef(relation.target, keyMap),
          }, warnings);
        }
      }

      return { tasks: created, warnings };
    });
  }

  get(id: string): Task | undefined {
    if (this.filePath) this.load();
    return this.tasks.get(id);
  }

  /** List all tasks, sorted by the given order (defaults to ID ascending). */
  list(sortOrder: TaskSortOrder = "id"): Task[] {
    if (this.filePath) this.load();
    return sortTasks(Array.from(this.tasks.values()), sortOrder);
  }

  update(id: string, fields: TaskUpdateFields): TaskMutationResult {
    const result = this.updateMany([{ taskId: id, ...fields }]);
    return result.results[0] ?? { task: undefined, changedFields: [], warnings: result.warnings };
  }

  updateMany(updates: Array<TaskUpdateFields & { taskId: string }>): TaskUpdateManyResult {
    return this.withLock(() => {
      const results = updates.map(({ taskId, ...fields }) => this.applyUpdate(taskId, fields));
      return {
        results,
        warnings: results.flatMap(result => result.warnings),
      };
    });
  }

  /** Delete a task by ID. Returns true if deleted. */
  delete(id: string): boolean {
    return this.withLock(() => {
      if (!this.tasks.has(id)) return false;
      this.tasks.delete(id);
      this.cleanupReferencesTo(id);
      return true;
    });
  }

  /** Remove all tasks. */
  clearAll(): number {
    return this.withLock(() => {
      const count = this.tasks.size;
      this.tasks.clear();
      return count;
    });
  }

  /** Capture full store state — used to carry tasks into a forked session. */
  snapshot(): TaskStoreData {
    if (this.filePath) this.load();
    return { nextId: this.nextId, tasks: Array.from(this.tasks.values()) };
  }

  /** Seed an empty store from a snapshot. No-op if the store already has tasks,
   *  so re-pointing to an already-seeded fork file never duplicates. */
  seed(data: TaskStoreData): void {
    this.withLock(() => {
      if (this.tasks.size > 0) return;
      this.nextId = Math.max(this.nextId, data.nextId);
      this.tasks.clear();
      for (const t of data.tasks) this.tasks.set(t.id, t);
    });
  }

  /** Delete the backing file (if file-backed and empty). */
  deleteFileIfEmpty(): boolean {
    const filePath = this.filePath;
    if (!filePath) return false;
    return this.withLock(() => {
      if (this.tasks.size > 0) return false;
      try {
        unlinkSync(filePath);
      } catch {
        /* ignore */
      }
      return true;
    }, { save: false });
  }

  /** Remove all completed tasks. */
  clearCompleted(): number {
    return this.withLock(() => {
      let count = 0;
      for (const [id, task] of this.tasks) {
        if (task.status === "completed") {
          this.tasks.delete(id);
          count++;
        }
      }
      // Clean up dependency edges and relationships for deleted tasks
      if (count > 0) {
        const validIds = new Set(this.tasks.keys());
        for (const t of this.tasks.values()) {
          t.blocks = t.blocks.filter(bid => validIds.has(bid));
          t.blockedBy = t.blockedBy.filter(bid => validIds.has(bid));
          t.relations = t.relations.filter(relation => validIds.has(relation.target));
        }
      }
      return count;
    });
  }
}
