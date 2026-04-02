import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ConversationStore } from './conversationStore';

// Brain directory where Antigravity stores conversations
const BRAIN_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || '',
  '.gemini',
  'antigravity',
  'brain',
);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ConversationData {
  id: string;
  displayName: string;
  lastModified: number;
  isPinned: boolean;
  summary?: string;
  order: number;
}

// WebviewView-based conversation panel with rich HTML cards
export class ConversationWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'conversationManager.webviewList';

  private _view?: vscode.WebviewView;
  private store: ConversationStore;
  private workspaceFilter: string | undefined;
  private cachedSummaries: Record<string, string> = {};

  constructor(
    private readonly extensionUri: vscode.Uri,
    store: ConversationStore,
  ) {
    this.store = store;
    this.workspaceFilter = this.getCurrentWorkspaceName();
  }

  private getCurrentWorkspaceName(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      return folders[0].uri.fsPath;
    }
    return undefined;
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };

    webviewView.webview.onDidReceiveMessage((message) => {
      switch (message.type) {
        case 'switchTo':
          vscode.commands.executeCommand(
            'conversationManager.switchTo',
            { conversationId: message.id, displayName: message.name },
          );
          break;
        case 'newConversation':
          vscode.commands.executeCommand('conversationManager.newConversation');
          break;
        case 'addExisting':
          vscode.commands.executeCommand('conversationManager.addExisting');
          break;
        case 'refresh':
          this.loadSummariesAsync().then(() => { this.refresh(); });
          break;

        case 'rename': {
          const currentName = this.store.getCustomName(message.id) || '';
          vscode.window.showInputBox({
            prompt: 'Enter conversation name',
            value: currentName,
            placeHolder: 'e.g. Fix login bug',
          }).then((name) => {
            if (name !== undefined) {
              this.store.rename(message.id, name);
              this.updateContent();
            }
          });
          break;
        }
        case 'remove': {
          // Remove from sidebar (clear workspace association) but keep brain dir
          this.store.removeWorkspace(message.id);
          this.updateContent();
          break;
        }
        case 'delete': {
          const displayName = message.name || message.id.substring(0, 8);
          vscode.window.showWarningMessage(
            `Delete conversation "${displayName}"? This permanently removes all artifacts.`,
            { modal: true },
            'Delete',
          ).then((choice) => {
            if (choice === 'Delete') {
              const dirPath = path.join(BRAIN_DIR, message.id);
              try { fs.rmSync(dirPath, { recursive: true, force: true }); } catch { /* skip */ }
              this.store.deleteMetadata(message.id);
              this.updateContent();
            }
          });
          break;
        }
        case 'moveUp': {
          const conversations = this.getConversations();
          const idx = conversations.findIndex((c) => c.id === message.id);
          if (idx > 0) {
            this.store.swapOrder(conversations[idx].id, conversations[idx - 1].id);
            this.updateContent();
          }
          break;
        }
        case 'moveDown': {
          const conversations = this.getConversations();
          const idx = conversations.findIndex((c) => c.id === message.id);
          if (idx >= 0 && idx < conversations.length - 1) {
            this.store.swapOrder(conversations[idx].id, conversations[idx + 1].id);
            this.updateContent();
          }
          break;
        }
        case 'reorder': {
          // Drag-and-drop reorder: insert message.fromId before message.beforeId
          const conversations = this.getConversations();
          const ids = conversations.map((c) => c.id);
          const fromIdx = ids.indexOf(message.fromId);
          if (fromIdx < 0) { break; }
          // Remove from current position
          ids.splice(fromIdx, 1);
          // Insert before target (or at end)
          const toIdx = message.beforeId ? ids.indexOf(message.beforeId) : ids.length;
          ids.splice(toIdx < 0 ? ids.length : toIdx, 0, message.fromId);
          // Re-assign sequential orders
          ids.forEach((id, i) => { this.store.setOrder(id, i); });
          this.updateContent();
          break;
        }
      }
    });

    this.updateContent();
    this.loadSummariesAsync().then(() => { this.updateContent(); });
  }

  refresh(): void {
    this.workspaceFilter = this.getCurrentWorkspaceName();
    this.updateContent();
  }

  // Public: used by extension's addExisting command
  public generateAutoNamePublic(id: string, dirPath: string): string {
    return this.generateAutoName(id, dirPath);
  }

  public getConversationSummaryPublic(id: string, dirPath: string): string | undefined {
    return this.cachedSummaries[id] || this.getLatestSummary(dirPath);
  }

  public isConversationEmptyPublic(dirPath: string): boolean {
    try {
      // If there are any recorded messages, it is NOT an empty conversation
      const msgPath = path.join(dirPath, '.system_generated', 'messages');
      if (fs.existsSync(msgPath)) {
        const msgs = fs.readdirSync(msgPath).filter(f => f.endsWith('.json'));
        if (msgs.length > 0) {
          return false; // It has chat history
        }
      }

      const files = fs.readdirSync(dirPath);
      // It's considered empty if it only contains the system folder or nothing
      const nonSystemFiles = files.filter(f => f !== '.system_generated');
      return nonSystemFiles.length === 0;
    } catch {
      return true; // Errors out -> assume empty/unusable
    }
  }

  // Public: check if conversation artifacts reference the current workspace
  public isContentMatchForWorkspace(dirPath: string): boolean {
    if (!this.workspaceFilter) { return false; }
    const workspaceName = path.basename(this.workspaceFilter);
    // Use word-boundary regex for basename to avoid substring false positives
    // e.g. "antigravity-conversation-manager" should not match "conversation-manager"
    const basenameRe = new RegExp(`(^|[\\s/\\\\])${workspaceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([\\s/\\\\]|$)`);
    const check = (filePath: string): boolean => {
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile() || stat.size > 200000) { return false; }
        const content = fs.readFileSync(filePath, 'utf-8');
        return content.includes(this.workspaceFilter!) || basenameRe.test(content);
      } catch { return false; }
    };
    try {
      // Scan top-level text files
      for (const file of fs.readdirSync(dirPath)) {
        if (!file.endsWith('.md') && !file.endsWith('.txt')
            && !file.endsWith('.json') && !file.includes('.resolved')) { continue; }
        if (file.startsWith('media__')) { continue; }
        if (check(path.join(dirPath, file))) { return true; }
      }
      // Scan .system_generated directory (context files, txt)
      const sysDir = path.join(dirPath, '.system_generated');
      if (fs.existsSync(sysDir)) {
        for (const file of fs.readdirSync(sysDir)) {
          if (file.endsWith('.txt') || file.endsWith('.json')) {
            if (check(path.join(sysDir, file))) { return true; }
          }
        }
      }
    } catch { /* skip */ }
    return false;
  }

  private loadSummariesAsync(): Promise<void> {
    return new Promise((resolve) => {
      try {
        const scriptPath = path.join(this.extensionUri.fsPath, 'scripts', 'extract_summaries.py');
        if (!fs.existsSync(scriptPath)) { resolve(); return; }
        const { exec } = require('child_process');
        exec(`python3 "${scriptPath}"`, { timeout: 2000 }, (err: any, stdout: string) => {
          if (!err && stdout) {
            try { this.cachedSummaries = JSON.parse(stdout); } catch { /* parse error */ }
          }
          resolve();
        });
      } catch { resolve(); }
    });
  }

  // Get conversations matching workspace filter, sorted by custom order
  getConversations(): ConversationData[] {
    if (!fs.existsSync(BRAIN_DIR)) { return []; }

    try {
      const entries = fs.readdirSync(BRAIN_DIR, { withFileTypes: true });
      const conversations: ConversationData[] = [];

      for (const entry of entries) {
        if (!entry.isDirectory() || !UUID_REGEX.test(entry.name)) { continue; }

        const dirPath = path.join(BRAIN_DIR, entry.name);
        const id = entry.name;
        const isPinned = this.store.isPinned(id);

        if (this.workspaceFilter && !this.isConversationInWorkspace(dirPath, id)) {
          continue;
        }

        // Last activity: find most recently modified file in the dir
        let lastModified = 0;
        try {
          for (const f of fs.readdirSync(dirPath)) {
            try {
              const fstat = fs.statSync(path.join(dirPath, f));
              if (fstat.isFile() && fstat.mtimeMs > lastModified) { lastModified = fstat.mtimeMs; }
            } catch { /* skip */ }
          }
          // Also check internal messages folder
          const msgPath = path.join(dirPath, '.system_generated', 'messages');
          if (fs.existsSync(msgPath)) {
            const msgStat = fs.statSync(msgPath);
            if (msgStat.mtimeMs > lastModified) { lastModified = msgStat.mtimeMs; }
            for (const f of fs.readdirSync(msgPath)) {
              try {
                const fstat = fs.statSync(path.join(msgPath, f));
                if (fstat.isFile() && fstat.mtimeMs > lastModified) { lastModified = fstat.mtimeMs; }
              } catch { /* skip */ }
            }
          }
        } catch { /* skip */ }
        if (lastModified === 0) { lastModified = fs.statSync(dirPath).mtimeMs; }
        const customName = this.store.getCustomName(id);
        const displayName = customName || this.generateAutoName(id, dirPath);
        const summary = this.cachedSummaries[id] || this.getLatestSummary(dirPath);
        const order = this.store.getOrder(id);

        conversations.push({ id, displayName, lastModified, isPinned, summary, order });
      }

      // Sort by custom order (lower first), then by lastModified as tiebreaker
      conversations.sort((a, b) => {
        if (a.order !== b.order) { return a.order - b.order; }
        return b.lastModified - a.lastModified;
      });

      // Auto-assign orders to content-matched conversations (default 999999)
      // so that Up/Down reordering has distinct values to swap
      if (conversations.some((c) => c.order === 999999)) {
        let maxOrder = 0;
        for (const c of conversations) {
          if (c.order !== 999999 && c.order > maxOrder) { maxOrder = c.order; }
        }
        for (const c of conversations) {
          if (c.order === 999999) {
            maxOrder++;
            this.store.setOrder(c.id, maxOrder);
            c.order = maxOrder;
          }
        }
      }

      return conversations;
    } catch {
      return [];
    }
  }

  private updateContent(): void {
    if (!this._view) { return; }
    const conversations = this.getConversations();
    this._view.webview.html = this.getHtml(conversations);
  }

  private getHtml(conversations: ConversationData[]): string {
    const renderCard = (c: ConversationData, idx: number, total: number) => {
      const timeStr = this.formatRelativeTime(c.lastModified);
      const summaryHtml = c.summary
        ? `<div class="card-summary">${this.escapeHtml(c.summary).replace(/\n/g, '<br>')}</div>`
        : '';
      const pinIcon = c.isPinned ? '<span class="pin-icon">&#128204;</span>' : '';

      return `
        <div class="card" draggable="true" data-id="${c.id}" data-name="${this.escapeHtml(c.displayName)}">
          <div class="card-header">
            <span class="drag-handle" title="Drag to reorder">&#9776;</span>
            ${pinIcon}
            <span class="card-title">${this.escapeHtml(c.displayName)}</span>
            <span class="card-actions">
              <span class="action-btn rename-btn" data-id="${c.id}" title="Rename">&#9998;</span>
              <span class="action-btn remove-btn" data-id="${c.id}" title="Remove from sidebar">&times;</span>
              <span class="action-btn delete-btn" data-id="${c.id}" data-name="${this.escapeHtml(c.displayName)}" title="Delete permanently">&#128465;</span>
              <span class="card-time">${timeStr}</span>
            </span>
          </div>
          ${summaryHtml}
        </div>
      `;
    };

    const cardsHtml = conversations.length > 0
      ? conversations.map((c, i) => renderCard(c, i, conversations.length)).join('')
      : '<div class="empty">No conversations. Click "+ New" or "+ Add" to get started.</div>';

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      padding: 8px;
    }
    .toolbar {
      display: flex;
      gap: 4px;
      margin-bottom: 8px;
    }
    .toolbar button {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      padding: 4px 8px;
      cursor: pointer;
      border-radius: 3px;
      font-size: 12px;
    }
    .toolbar button:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .card {
      padding: 8px 10px;
      margin-bottom: 4px;
      border-radius: 4px;
      cursor: pointer;
      background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.04));
      border: 1px solid transparent;
      transition: all 0.1s ease;
    }
    .card:hover {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
      border-color: var(--vscode-focusBorder);
    }
    .card-header {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .card-title {
      font-weight: 600;
      font-size: 13px;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .card-time {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      white-space: nowrap;
      flex-shrink: 0;
    }
    .card-actions {
      display: flex;
      align-items: center;
      gap: 2px;
      flex-shrink: 0;
    }
    .action-btn {
      cursor: pointer;
      opacity: 0;
      font-size: 13px;
      padding: 0 2px;
      transition: opacity 0.1s;
    }
    .card:hover .action-btn { opacity: 0.5; }
    .action-btn:hover { opacity: 1 !important; }
    .remove-btn { font-size: 16px; font-weight: bold; }
    .drag-handle {
      cursor: grab;
      opacity: 0.3;
      font-size: 12px;
      flex-shrink: 0;
      user-select: none;
      transition: opacity 0.1s;
    }
    .card:hover .drag-handle { opacity: 0.7; }
    .drag-handle:hover { opacity: 1 !important; }
    .card.dragging { opacity: 0.4; }
    .card.drag-over { border-top: 2px solid var(--vscode-focusBorder); margin-top: -2px; }
    .card-summary {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      line-height: 1.4;
      margin-top: 4px;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .card:hover .card-summary {
      color: var(--vscode-list-activeSelectionForeground);
      opacity: 0.8;
    }
    .pin-icon { font-size: 12px; flex-shrink: 0; }
    .empty {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      padding: 16px 8px;
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <button onclick="send('newConversation')">+ New</button>
    <button onclick="send('addExisting')">+ Add</button>
    <button onclick="send('refresh')" title="Refresh">&#8635;</button>
  </div>
  ${cardsHtml}
  <script>
    const vscode = acquireVsCodeApi();
    function send(type) { vscode.postMessage({ type }); }

    document.querySelectorAll('.card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.action-btn')) { return; }
        vscode.postMessage({ type: 'switchTo', id: card.dataset.id, name: card.dataset.name });
      });
    });
    document.querySelectorAll('.rename-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'rename', id: btn.dataset.id });
      });
    });
    document.querySelectorAll('.remove-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'remove', id: btn.dataset.id });
      });
    });
    document.querySelectorAll('.delete-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'delete', id: btn.dataset.id, name: btn.dataset.name });
      });
    });
    // Drag and drop reordering
    let dragId = null;
    document.querySelectorAll('.card').forEach(card => {
      card.addEventListener('dragstart', (e) => {
        dragId = card.dataset.id;
        card.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
      });
      card.addEventListener('dragend', () => {
        card.classList.remove('dragging');
        document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
        dragId = null;
      });
      card.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (card.dataset.id !== dragId) {
          document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
          card.classList.add('drag-over');
        }
      });
      card.addEventListener('dragleave', () => { card.classList.remove('drag-over'); });
      card.addEventListener('drop', (e) => {
        e.preventDefault();
        card.classList.remove('drag-over');
        if (dragId && card.dataset.id !== dragId) {
          vscode.postMessage({ type: 'reorder', fromId: dragId, beforeId: card.dataset.id });
        }
      });
    });
  </script>
</body>
</html>`;
  }

  private formatRelativeTime(timestamp: number): string {
    const now = Date.now();
    const diffMs = now - timestamp;
    const diffMin = Math.floor(diffMs / 60000);
    const diffHr = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHr / 24);

    if (diffMin < 1) { return 'just now'; }
    if (diffMin < 60) { return `${diffMin}m ago`; }
    if (diffHr < 24) { return `${diffHr}h ago`; }
    if (diffDay < 30) { return `${diffDay}d ago`; }
    return new Date(timestamp).toLocaleDateString();
  }

  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // --- Data extraction methods ---

  private isConversationInWorkspace(dirPath: string, id: string): boolean {
    if (!this.workspaceFilter) { return true; }
    if (this.store.isPinned(id)) { return true; }

    // Check stored workspace association ('' means explicitly removed)
    const storedWorkspace = this.store.getWorkspace(id);
    if (storedWorkspace !== undefined) {
      return storedWorkspace === this.workspaceFilter;
    }

    // Fallback: check file content for workspace name
    return this.isContentMatchForWorkspace(dirPath);
  }

  private generateAutoName(id: string, dirPath: string): string {
    // Priority 1: Heading from artifact files
    for (const file of ['task.md', 'implementation_plan.md', 'walkthrough.md']) {
      const filePath = path.join(dirPath, file);
      if (fs.existsSync(filePath)) {
        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          const firstLine = content.split('\n').find(
            (line) => line.trim().length > 0 && line.startsWith('#'),
          );
          if (firstLine) {
            const title = firstLine.replace(/^#+\s*/, '').trim();
            if (title.length > 0 && title.length <= 60) { return title; }
            if (title.length > 60) { return title.substring(0, 57) + '...'; }
          }
        } catch { /* skip */ }
      }
    }

    // Priority 2: metadata.json summary
    try {
      const files = fs.readdirSync(dirPath);
      let bestSummary = '';
      let bestTime = 0;
      for (const file of files) {
        if (!file.endsWith('.metadata.json')) { continue; }
        try {
          const raw = fs.readFileSync(path.join(dirPath, file), 'utf-8');
          const meta = JSON.parse(raw);
          if (meta.summary && meta.updatedAt) {
            const t = new Date(meta.updatedAt).getTime();
            if (t > bestTime) { bestTime = t; bestSummary = meta.summary; }
          }
        } catch { /* skip */ }
      }
      if (bestSummary) {
        const line = bestSummary.split('\n')[0].trim();
        if (line.length > 0 && line.length <= 60) { return line; }
        if (line.length > 60) { return line.substring(0, 57) + '...'; }
      }
    } catch { /* skip */ }

    // Priority 3: last_prompt.txt
    const promptPath = path.join(dirPath, 'last_prompt.txt');
    if (fs.existsSync(promptPath)) {
      try {
        const content = fs.readFileSync(promptPath, 'utf-8').trim();
        const line = content.split('\n')[0].trim();
        if (line.length > 0 && line.length <= 60) { return line; }
        if (line.length > 60) { return line.substring(0, 57) + '...'; }
      } catch { /* skip */ }
    }

    return id.substring(0, 8);
  }

  private getLatestSummary(dirPath: string): string | undefined {
    const taskPreview = this.getTaskPreview(dirPath);
    if (taskPreview) { return taskPreview; }

    try {
      const files = fs.readdirSync(dirPath);
      let bestSummary: string | undefined;
      let bestTime = 0;
      for (const file of files) {
        if (!file.endsWith('.metadata.json')) { continue; }
        try {
          const raw = fs.readFileSync(path.join(dirPath, file), 'utf-8');
          const meta = JSON.parse(raw);
          if (meta.summary && meta.updatedAt) {
            const t = new Date(meta.updatedAt).getTime();
            if (t > bestTime) { bestTime = t; bestSummary = meta.summary; }
          }
        } catch { /* skip */ }
      }
      return bestSummary;
    } catch {
      return undefined;
    }
  }

  private getTaskPreview(dirPath: string): string | undefined {
    const taskPath = path.join(dirPath, 'task.md');
    if (!fs.existsSync(taskPath)) { return undefined; }

    try {
      const content = fs.readFileSync(taskPath, 'utf-8');
      const lines = content.split('\n');
      const activeItems: string[] = [];
      for (let i = lines.length - 1; i >= 0 && activeItems.length < 2; i--) {
        const line = lines[i].trim();
        if (line.match(/^-\s*\[(x|\/)\]/)) {
          const item = line
            .replace(/^-\s*\[(x|\/)\]\s*/, '')
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
            .replace(/`([^`]+)`/g, '$1')
            .trim();
          if (item.length > 0) { activeItems.unshift(item); }
        }
      }
      if (activeItems.length === 0) { return undefined; }
      return activeItems.map((item) => {
        const truncated = item.length > 80 ? item.substring(0, 77) + '...' : item;
        return `\u2713 ${truncated}`;
      }).join('\n');
    } catch {
      return undefined;
    }
  }
}
