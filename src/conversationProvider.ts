import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ConversationItem } from './conversationItem';
import { ConversationStore } from './conversationStore';

// Brain directory where Antigravity stores conversations
const BRAIN_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || '',
  '.gemini',
  'antigravity',
  'brain',
);

// UUID pattern for conversation directories
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Provides data for the conversation TreeView
export class ConversationProvider implements vscode.TreeDataProvider<ConversationItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<ConversationItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private store: ConversationStore;
  private filterPinned: boolean;
  private workspaceFilter: string | undefined;

  constructor(store: ConversationStore, filterPinned: boolean) {
    this.store = store;
    this.filterPinned = filterPinned;
    // Detect current workspace name for filtering
    this.workspaceFilter = this.getCurrentWorkspaceName();
  }

  // Get the current workspace folder name
  private getCurrentWorkspaceName(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      return folders[0].uri.fsPath;
    }
    return undefined;
  }

  refresh(): void {
    this.workspaceFilter = this.getCurrentWorkspaceName();
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: ConversationItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<ConversationItem[]> {
    if (!fs.existsSync(BRAIN_DIR)) {
      return [];
    }

    try {
      const entries = fs.readdirSync(BRAIN_DIR, { withFileTypes: true });
      const conversations: ConversationItem[] = [];

      for (const entry of entries) {
        // Only process UUID-named directories
        if (!entry.isDirectory() || !UUID_REGEX.test(entry.name)) {
          continue;
        }

        const dirPath = path.join(BRAIN_DIR, entry.name);
        const id = entry.name;
        const isPinned = this.store.isPinned(id);

        // Filter: pinned list only shows pinned, recent list shows unpinned
        if (this.filterPinned && !isPinned) {
          continue;
        }
        if (!this.filterPinned && isPinned) {
          continue;
        }

        // Workspace filter: check if conversation is linked to current workspace
        if (this.workspaceFilter && !this.isConversationInWorkspace(dirPath, id)) {
          continue;
        }

        // Get last modification time
        const stat = fs.statSync(dirPath);
        const lastModified = stat.mtimeMs;

        // Get display name
        const customName = this.store.getCustomName(id);
        const displayName = customName || this.generateAutoName(id, dirPath);

        // Get latest summary from metadata files
        const summary = this.getLatestSummary(dirPath);

        conversations.push(
          new ConversationItem(id, displayName, lastModified, isPinned, summary),
        );
      }

      // Sort by last modified time (most recent first)
      conversations.sort((a, b) => b.lastModified - a.lastModified);

      return conversations;
    } catch {
      return [];
    }
  }

  // Check if a conversation belongs to the current workspace
  // Strategy: look for workspace path references in artifacts or .system_generated
  private isConversationInWorkspace(dirPath: string, _id: string): boolean {
    if (!this.workspaceFilter) {
      return true;
    }

    const workspaceName = path.basename(this.workspaceFilter);

    // Check if any artifact files reference the current workspace
    const filesToCheck = ['task.md', 'implementation_plan.md', 'walkthrough.md'];
    for (const file of filesToCheck) {
      const filePath = path.join(dirPath, file);
      if (fs.existsSync(filePath)) {
        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          if (content.includes(this.workspaceFilter) || content.includes(workspaceName)) {
            return true;
          }
        } catch {
          // Skip unreadable files
        }
      }
    }

    // Check .system_generated directory for any workspace references
    const sysGenDir = path.join(dirPath, '.system_generated');
    if (fs.existsSync(sysGenDir)) {
      try {
        const sysFiles = fs.readdirSync(sysGenDir, { withFileTypes: true });
        for (const sf of sysFiles) {
          if (sf.isFile() && sf.name.endsWith('.txt')) {
            const content = fs.readFileSync(path.join(sysGenDir, sf.name), 'utf-8');
            if (content.includes(this.workspaceFilter!) || content.includes(workspaceName)) {
              return true;
            }
          }
        }
      } catch {
        // Skip
      }
    }

    // If pinned by user, always show regardless of workspace
    if (this.store.isPinned(_id)) {
      return true;
    }

    // If we cannot determine workspace affiliation, don't show it
    // (conservative: only show conversations we can confirm belong here)
    return false;
  }

  // Try to extract a meaningful name from conversation artifacts or use short ID
  private generateAutoName(id: string, dirPath: string): string {
    // Try reading task.md for a title
    const taskPath = path.join(dirPath, 'task.md');
    if (fs.existsSync(taskPath)) {
      try {
        const content = fs.readFileSync(taskPath, 'utf-8');
        const firstLine = content.split('\n').find(
          (line) => line.trim().length > 0 && line.startsWith('#'),
        );
        if (firstLine) {
          const title = firstLine.replace(/^#+\s*/, '').trim();
          if (title.length > 0 && title.length <= 60) {
            return title;
          }
          if (title.length > 60) {
            return title.substring(0, 57) + '...';
          }
        }
      } catch {
        // Fall through
      }
    }

    // Try reading implementation_plan.md for a title
    const planPath = path.join(dirPath, 'implementation_plan.md');
    if (fs.existsSync(planPath)) {
      try {
        const content = fs.readFileSync(planPath, 'utf-8');
        const firstLine = content.split('\n').find(
          (line) => line.trim().length > 0 && line.startsWith('#'),
        );
        if (firstLine) {
          const title = firstLine.replace(/^#+\s*/, '').trim();
          if (title.length > 0 && title.length <= 60) {
            return title;
          }
          if (title.length > 60) {
            return title.substring(0, 57) + '...';
          }
        }
      } catch {
        // Fall through
      }
    }

    // Fallback: short UUID prefix
    return id.substring(0, 8);
  }

  // Read all *.metadata.json files and return the summary
  // from the most recently updated one
  private getLatestSummary(dirPath: string): string | undefined {
    try {
      const files = fs.readdirSync(dirPath);
      let bestSummary: string | undefined;
      let bestTime = 0;

      for (const file of files) {
        if (!file.endsWith('.metadata.json')) {
          continue;
        }
        try {
          const raw = fs.readFileSync(path.join(dirPath, file), 'utf-8');
          const meta = JSON.parse(raw);
          if (meta.summary && meta.updatedAt) {
            const t = new Date(meta.updatedAt).getTime();
            if (t > bestTime) {
              bestTime = t;
              bestSummary = meta.summary;
            }
          }
        } catch {
          // Skip malformed metadata
        }
      }

      return bestSummary;
    } catch {
      return undefined;
    }
  }
}
