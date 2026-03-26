import * as fs from 'fs';
import * as path from 'path';

// Metadata stored per conversation
export interface ConversationMetadata {
  id: string;
  customName?: string;
  pinned: boolean;
  createdAt: number;
  lastModified: number;
  notes?: string;
  workspace?: string;
  order?: number; // Custom display order (lower = higher)
}

// The store persists custom metadata (names, pins, workspace, order) as JSON
export class ConversationStore {
  private storePath: string;
  private data: Map<string, ConversationMetadata> = new Map();

  constructor(storagePath: string) {
    this.storePath = path.join(storagePath, 'conversations.json');
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.storePath)) {
        const raw = fs.readFileSync(this.storePath, 'utf-8');
        const parsed = JSON.parse(raw) as Record<string, ConversationMetadata>;
        for (const [key, val] of Object.entries(parsed)) {
          this.data.set(key, val);
        }
      }
    } catch {
      this.data = new Map();
    }
  }

  private save(): void {
    const dir = path.dirname(this.storePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const obj: Record<string, ConversationMetadata> = {};
    for (const [key, val] of this.data) {
      obj[key] = val;
    }
    fs.writeFileSync(this.storePath, JSON.stringify(obj, null, 2), 'utf-8');
  }

  private getOrCreate(id: string): ConversationMetadata {
    return this.data.get(id) || {
      id,
      pinned: false,
      createdAt: Date.now(),
      lastModified: Date.now(),
    };
  }

  // Get or create metadata for a conversation
  getMetadata(id: string, lastModified: number): ConversationMetadata {
    if (this.data.has(id)) {
      const meta = this.data.get(id)!;
      meta.lastModified = lastModified;
      return meta;
    }
    return {
      id,
      pinned: false,
      createdAt: lastModified,
      lastModified,
    };
  }

  rename(id: string, name: string): void {
    const meta = this.getOrCreate(id);
    meta.customName = name;
    this.data.set(id, meta);
    this.save();
  }

  pin(id: string): void {
    const meta = this.getOrCreate(id);
    meta.pinned = true;
    this.data.set(id, meta);
    this.save();
  }

  unpin(id: string): void {
    const meta = this.data.get(id);
    if (meta) {
      meta.pinned = false;
      this.data.set(id, meta);
      this.save();
    }
  }

  isPinned(id: string): boolean {
    return this.data.get(id)?.pinned ?? false;
  }

  getCustomName(id: string): string | undefined {
    return this.data.get(id)?.customName;
  }

  deleteMetadata(id: string): void {
    this.data.delete(id);
    this.save();
  }

  getAllPinnedIds(): string[] {
    const pinned: string[] = [];
    for (const [id, meta] of this.data) {
      if (meta.pinned) { pinned.push(id); }
    }
    return pinned;
  }

  // Workspace association
  associateWorkspace(id: string, workspacePath: string): void {
    const meta = this.getOrCreate(id);
    meta.workspace = workspacePath;
    // Assign next order number if not set
    if (meta.order === undefined) {
      meta.order = this.getNextOrder();
    }
    this.data.set(id, meta);
    this.save();
  }

  removeWorkspace(id: string): void {
    const meta = this.data.get(id);
    if (meta) {
      delete meta.workspace;
      delete meta.order;
      this.data.set(id, meta);
      this.save();
    }
  }

  getWorkspace(id: string): string | undefined {
    return this.data.get(id)?.workspace;
  }

  // Ordering
  getOrder(id: string): number {
    return this.data.get(id)?.order ?? 999999;
  }

  setOrder(id: string, order: number): void {
    const meta = this.getOrCreate(id);
    meta.order = order;
    this.data.set(id, meta);
    this.save();
  }

  swapOrder(idA: string, idB: string): void {
    const orderA = this.getOrder(idA);
    const orderB = this.getOrder(idB);
    this.setOrder(idA, orderB);
    this.setOrder(idB, orderA);
  }

  private getNextOrder(): number {
    let max = 0;
    for (const meta of this.data.values()) {
      if (meta.order !== undefined && meta.order > max) { max = meta.order; }
    }
    return max + 1;
  }
}
