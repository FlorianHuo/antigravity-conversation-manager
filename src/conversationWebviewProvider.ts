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
    webviewView.webview.options = {
      enableScripts: true,
    };

    // Handle messages from the webview
    webviewView.webview.onDidReceiveMessage((message) => {
      switch (message.type) {
        case 'switchTo':
          vscode.commands.executeCommand(
            'conversationManager.switchTo',
            { conversationId: message.id, displayName: message.name },
          );
          break;
        case 'newConversation':
          vscode.commands.executeCommand('conversationManager.new');
          break;
        case 'refresh':
          this.refresh();
          break;
      }
    });

    // Render immediately with whatever data we have
    this.updateContent();
    // Load summaries in background, re-render when done
    this.loadSummariesAsync().then(() => {
      this.updateContent();
    });
  }

  refresh(): void {
    this.workspaceFilter = this.getCurrentWorkspaceName();
    this.updateContent();
  }

  // Load per-conversation summaries by calling the Python extraction script (async)
  private loadSummariesAsync(): Promise<void> {
    return new Promise((resolve) => {
      try {
        const scriptPath = path.join(
          this.extensionUri.fsPath, 'scripts', 'extract_summaries.py',
        );
        if (!fs.existsSync(scriptPath)) {
          resolve();
          return;
        }
        const { exec } = require('child_process');
        exec(`python3 "${scriptPath}"`, { timeout: 2000 }, (err: any, stdout: string) => {
          if (!err && stdout) {
            try {
              this.cachedSummaries = JSON.parse(stdout);
            } catch { /* parse error */ }
          }
          resolve();
        });
      } catch {
        resolve();
      }
    });
  }

  // Get all conversations matching current filters
  getConversations(): ConversationData[] {
    if (!fs.existsSync(BRAIN_DIR)) {
      return [];
    }

    try {
      const entries = fs.readdirSync(BRAIN_DIR, { withFileTypes: true });
      const conversations: ConversationData[] = [];

      for (const entry of entries) {
        if (!entry.isDirectory() || !UUID_REGEX.test(entry.name)) {
          continue;
        }

        const dirPath = path.join(BRAIN_DIR, entry.name);
        const id = entry.name;
        const isPinned = this.store.isPinned(id);

        // Workspace filter
        if (this.workspaceFilter && !this.isConversationInWorkspace(dirPath, id)) {
          continue;
        }

        const stat = fs.statSync(dirPath);
        const lastModified = stat.mtimeMs;
        const customName = this.store.getCustomName(id);
        const displayName = customName || this.generateAutoName(id, dirPath);
        const summary = this.cachedSummaries[id] || this.getLatestSummary(dirPath);

        conversations.push({ id, displayName, lastModified, isPinned, summary });
      }

      conversations.sort((a, b) => b.lastModified - a.lastModified);
      return conversations;
    } catch {
      return [];
    }
  }

  private updateContent(): void {
    if (!this._view) {
      return;
    }

    const conversations = this.getConversations();
    const pinned = conversations.filter((c) => c.isPinned);
    const recent = conversations.filter((c) => !c.isPinned);

    this._view.webview.html = this.getHtml(pinned, recent);
  }

  private getHtml(pinned: ConversationData[], recent: ConversationData[]): string {
    const renderCard = (c: ConversationData) => {
      const timeStr = this.formatRelativeTime(c.lastModified);
      const summaryHtml = c.summary
        ? `<div class="card-summary">${this.escapeHtml(c.summary).replace(/\n/g, '<br>')}</div>`
        : '';
      const pinIcon = c.isPinned ? '<span class="pin-icon">&#128204;</span>' : '';

      return `
        <div class="card" data-id="${c.id}" data-name="${this.escapeHtml(c.displayName)}">
          <div class="card-header">
            ${pinIcon}
            <span class="card-title">${this.escapeHtml(c.displayName)}</span>
            <span class="card-time">${timeStr}</span>
          </div>
          ${summaryHtml}
        </div>
      `;
    };

    const pinnedSection = pinned.length > 0
      ? `<div class="section">
           <div class="section-title">Pinned</div>
           ${pinned.map(renderCard).join('')}
         </div>`
      : '';

    const recentSection = `
      <div class="section">
        <div class="section-title">Recent</div>
        ${recent.length > 0
          ? recent.map(renderCard).join('')
          : '<div class="empty">No conversations found</div>'
        }
      </div>
    `;

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
    .section { margin-bottom: 12px; }
    .section-title {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 6px;
      padding: 0 4px;
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
      margin-bottom: 4px;
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
    .card-summary {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      line-height: 1.4;
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
      padding: 8px;
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <button onclick="send('newConversation')">+ New</button>
    <button id="refreshBtn" onclick="doRefresh()">Refresh</button>
  </div>
  ${pinnedSection}
  ${recentSection}
  <script>
    const vscode = acquireVsCodeApi();
    function send(type) { vscode.postMessage({ type }); }
    function doRefresh() {
      const btn = document.getElementById('refreshBtn');
      btn.textContent = 'Refreshing...';
      btn.disabled = true;
      btn.style.opacity = '0.6';
      send('refresh');
      setTimeout(() => { btn.textContent = 'Refresh'; btn.disabled = false; btn.style.opacity = '1'; }, 1500);
    }
    document.querySelectorAll('.card').forEach(card => {
      card.addEventListener('click', () => {
        vscode.postMessage({
          type: 'switchTo',
          id: card.dataset.id,
          name: card.dataset.name,
        });
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

  // --- Data extraction methods (same as ConversationProvider) ---

  private isConversationInWorkspace(dirPath: string, id: string): boolean {
    if (!this.workspaceFilter) { return true; }

    // Always show pinned conversations
    if (this.store.isPinned(id)) { return true; }

    // Show empty dirs created in the last 2 hours (new conversations have no workspace info)
    try {
      const files = fs.readdirSync(dirPath);
      if (files.length === 0) {
        const stat = fs.statSync(dirPath);
        const ageHours = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60);
        if (ageHours < 2) { return true; }
        return false; // Old empty dir, hide it
      }
    } catch { /* skip */ }

    const workspaceName = path.basename(this.workspaceFilter);

    const filesToCheck = ['task.md', 'implementation_plan.md', 'walkthrough.md'];
    for (const file of filesToCheck) {
      const filePath = path.join(dirPath, file);
      if (fs.existsSync(filePath)) {
        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          if (content.includes(this.workspaceFilter!) || content.includes(workspaceName)) {
            return true;
          }
        } catch { /* skip */ }
      }
    }

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
      } catch { /* skip */ }
    }

    return false;
  }

  private generateAutoName(id: string, dirPath: string): string {
    for (const file of ['task.md', 'implementation_plan.md']) {
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
    return id.substring(0, 8);
  }


  private getLatestSummary(dirPath: string): string | undefined {
    // Priority 1: Last active task items from task.md
    const taskPreview = this.getTaskPreview(dirPath);
    if (taskPreview) { return taskPreview; }

    // Priority 2: Most recent metadata.json summary
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
            if (t > bestTime) {
              bestTime = t;
              bestSummary = meta.summary;
            }
          }
        } catch { /* skip */ }
      }
      return bestSummary;
    } catch {
      return undefined;
    }
  }

  // Extract the last completed [x] or in-progress [/] task items from task.md
  private getTaskPreview(dirPath: string): string | undefined {
    const taskPath = path.join(dirPath, 'task.md');
    if (!fs.existsSync(taskPath)) { return undefined; }

    try {
      const content = fs.readFileSync(taskPath, 'utf-8');
      const lines = content.split('\n');

      // Find last [x] or [/] items (most recent work)
      const activeItems: string[] = [];
      for (let i = lines.length - 1; i >= 0 && activeItems.length < 2; i--) {
        const line = lines[i].trim();
        if (line.match(/^-\s*\[(x|\/)\]/)) {
          // Clean up markdown formatting
          const item = line
            .replace(/^-\s*\[(x|\/)\]\s*/, '')
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')  // strip links
            .replace(/`([^`]+)`/g, '$1')                // strip backticks
            .trim();
          if (item.length > 0) {
            activeItems.unshift(item);  // keep chronological order
          }
        }
      }

      if (activeItems.length === 0) { return undefined; }

      // Format: show last items with checkmark prefix
      return activeItems.map((item) => {
        const truncated = item.length > 80 ? item.substring(0, 77) + '...' : item;
        return `\u2713 ${truncated}`;
      }).join('\n');
    } catch {
      return undefined;
    }
  }
}
