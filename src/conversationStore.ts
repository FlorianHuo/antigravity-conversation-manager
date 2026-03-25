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
  workspace?: string; // Auto-recorded workspace path
}

// The store persists custom metadata (names, pins) as JSON
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
      // If corrupted, start fresh
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
    const meta = this.data.get(id) || {
      id,
      pinned: false,
      createdAt: Date.now(),
      lastModified: Date.now(),
    };
    meta.customName = name;
    this.data.set(id, meta);
    this.save();
  }

  pin(id: string): void {
    const meta = this.data.get(id) || {
      id,
      pinned: false,
      createdAt: Date.now(),
      lastModified: Date.now(),
    };
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
      if (meta.pinned) {
        pinned.push(id);
      }
    }
    return pinned;
  }

  // Associate a conversation with a workspace (called when new dirs are detected)
  associateWorkspace(id: string, workspacePath: string): void {
    const meta = this.data.get(id) || {
      id,
      pinned: false,
      createdAt: Date.now(),
      lastModified: Date.now(),
    };
    if (!meta.workspace) {
      meta.workspace = workspacePath;
      this.data.set(id, meta);
      this.save();
    }
  }

  getWorkspace(id: string): string | undefined {
    return this.data.get(id)?.workspace;
  }
}
