import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ConversationWebviewProvider } from './conversationWebviewProvider';
import { ConversationStore } from './conversationStore';

// Brain directory path
const BRAIN_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || '',
  '.gemini',
  'antigravity',
  'brain',
);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Switch to a specific conversation using the patched workbench command.
 */
async function switchToConversation(
  outputChannel: vscode.OutputChannel,
  conversationId: string,
  displayName: string,
): Promise<void> {
  outputChannel.appendLine(
    `\n=== Switching to: ${conversationId} (${displayName}) ===`,
  );

  const availableCommands = new Set(await vscode.commands.getCommands(true));

  if (availableCommands.has('antigravity.switchConversation')) {
    try {
      await vscode.commands.executeCommand('antigravity.switchConversation', conversationId);
      outputChannel.appendLine('  Switch successful via antigravity.switchConversation');
      outputChannel.appendLine('=== Switch completed ===');
      return;
    } catch (error) {
      outputChannel.appendLine(`  antigravity.switchConversation failed: ${error}`);
    }
  }

  outputChannel.appendLine('  Patched command not available, using fallback...');
  try {
    await vscode.commands.executeCommand('antigravity.forceFocusManager');
    await sleep(300);
    outputChannel.appendLine('  Opened Manager via forceFocusManager (manual switch needed)');
  } catch (error) {
    outputChannel.appendLine(`  Fallback also failed: ${error}`);
    vscode.window.showErrorMessage('Could not switch conversation. Run patch_workbench.py first.');
  }
  outputChannel.appendLine('=== Switch completed ===');
}

let switchInProgress = false;

// Pending new conversation state: watcher will auto-associate when brain dir appears
let pendingNewBeforeIds: Set<string> | null = null;
let pendingNewWorkspace: string | null = null;

export function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel('Conversation Manager');
  outputChannel.appendLine('Conversation Manager activating...');

  const store = new ConversationStore(context.globalStorageUri.fsPath);

  const webviewProvider = new ConversationWebviewProvider(context.extensionUri, store);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ConversationWebviewProvider.viewType,
      webviewProvider,
    ),
  );

  function getCurrentWorkspace(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  function refreshAll() {
    webviewProvider.refresh();
  }

  // Watch the brain directory for UI refreshes + pending new conversation detection
  if (fs.existsSync(BRAIN_DIR)) {
    try {
      const watcher = fs.watch(BRAIN_DIR, { persistent: false }, () => {
        // Auto-associate pending new conversation when its brain dir appears
        if (pendingNewBeforeIds && pendingNewWorkspace) {
          try {
            for (const e of fs.readdirSync(BRAIN_DIR, { withFileTypes: true })) {
              if (e.isDirectory() && UUID_RE.test(e.name)
                  && !pendingNewBeforeIds.has(e.name)
                  && !store.getWorkspace(e.name)) {
                store.associateWorkspace(e.name, pendingNewWorkspace);
                outputChannel.appendLine(`[watcher] Associated new ${e.name.substring(0, 8)}`);
                pendingNewBeforeIds = null;
                pendingNewWorkspace = null;
                break;
              }
            }
          } catch { /* skip */ }
        }
        refreshAll();
      });
      context.subscriptions.push({ dispose: () => watcher.close() });
    } catch (err) {
      outputChannel.appendLine(`Warning: could not watch brain directory: ${err}`);
    }
  }

  // ---- Commands ----

  // New conversation: create + associate with current workspace
  context.subscriptions.push(
    vscode.commands.registerCommand('conversationManager.newConversation', async () => {
      // Snapshot before
      const beforeIds = new Set<string>();
      if (fs.existsSync(BRAIN_DIR)) {
        for (const e of fs.readdirSync(BRAIN_DIR, { withFileTypes: true })) {
          if (e.isDirectory() && UUID_RE.test(e.name)) { beforeIds.add(e.name); }
        }
      }

      try {
        await vscode.commands.executeCommand('antigravity.startNewConversation');
        outputChannel.appendLine('Started new conversation');
      } catch {
        try {
          await vscode.commands.executeCommand('antigravity.prioritized.chat.openNewConversation');
        } catch {
          try {
            await vscode.commands.executeCommand('workbench.action.chat.newChat');
          } catch (err) {
            vscode.window.showErrorMessage(`Failed to create new conversation: ${err}`);
          }
        }
      }

      // Detect and associate new dir (immediate + watcher-based)
      const ws = getCurrentWorkspace();
      if (ws && fs.existsSync(BRAIN_DIR)) {
        // Set pending state so the fs.watch callback can detect it later
        pendingNewBeforeIds = beforeIds;
        pendingNewWorkspace = ws;
        // Clear pending after 60s to avoid stale state
        setTimeout(() => { pendingNewBeforeIds = null; pendingNewWorkspace = null; }, 60000);

        // Also try immediate + short retries
        const tryDetect = () => {
          if (!pendingNewBeforeIds) { return true; } // already found by watcher
          for (const e of fs.readdirSync(BRAIN_DIR, { withFileTypes: true })) {
            if (e.isDirectory() && UUID_RE.test(e.name)
                && !beforeIds.has(e.name) && !store.getWorkspace(e.name)) {
              store.associateWorkspace(e.name, ws);
              outputChannel.appendLine(`Associated new ${e.name.substring(0, 8)} with ${path.basename(ws)}`);
              pendingNewBeforeIds = null;
              pendingNewWorkspace = null;
              refreshAll();
              return true;
            }
          }
          refreshAll();
          return false;
        };
        if (!tryDetect()) {
          setTimeout(() => { if (!tryDetect()) { setTimeout(tryDetect, 2000); } }, 500);
        }
      }
    }),
  );

  // Add existing conversation: QuickPick showing all unassociated conversations
  context.subscriptions.push(
    vscode.commands.registerCommand('conversationManager.addExisting', async () => {
      const ws = getCurrentWorkspace();
      if (!ws || !fs.existsSync(BRAIN_DIR)) { return; }

      // Gather conversation dirs for this workspace that aren't in sidebar
      const currentIds = new Set(webviewProvider.getConversations().map((c) => c.id));
      const candidates: { id: string; name: string; mtime: number }[] = [];
      for (const e of fs.readdirSync(BRAIN_DIR, { withFileTypes: true })) {
        if (!e.isDirectory() || !UUID_RE.test(e.name)) { continue; }
        if (currentIds.has(e.name)) { continue; } // already in sidebar
        const dirPath = path.join(BRAIN_DIR, e.name);
        const existingWs = store.getWorkspace(e.name);
        if (existingWs === ws) { continue; } // already associated (should be in sidebar)
        // Removed conversations (workspace=''): always show for re-add
        // Other-workspace or orphan: require content match
        if (existingWs !== '' && !webviewProvider.isContentMatchForWorkspace(dirPath)) { continue; }
        const stat = fs.statSync(dirPath);
        const name = webviewProvider.generateAutoNamePublic(e.name, dirPath);
        candidates.push({ id: e.name, name, mtime: stat.mtimeMs });
      }

      // Sort by most recently modified
      candidates.sort((a, b) => b.mtime - a.mtime);

      const picks = candidates.map((c) => ({
        label: c.name,
        description: c.id.substring(0, 8),
        detail: new Date(c.mtime).toLocaleString(),
        id: c.id,
      }));

      const selected = await vscode.window.showQuickPick(picks, {
        placeHolder: 'Select a conversation to add to this workspace...',
        matchOnDescription: true,
        matchOnDetail: true,
      });

      if (selected) {
        store.associateWorkspace(selected.id, ws);
        outputChannel.appendLine(`Added ${selected.id.substring(0, 8)} (${selected.label}) to workspace`);
        refreshAll();
      }
    }),
  );

  // QuickPick picker for keyboard shortcut
  context.subscriptions.push(
    vscode.commands.registerCommand('conversationManager.openPicker', async () => {
      const allItems = webviewProvider.getConversations();
      const picks = allItems.map((c) => ({
        label: `${c.isPinned ? '$(pin) ' : ''}${c.displayName}`,
        description: c.id.slice(0, 8),
        detail: c.summary || undefined,
        conversationId: c.id,
        displayName: c.displayName,
      }));

      const selected = await vscode.window.showQuickPick(picks, {
        placeHolder: 'Search conversations...',
        matchOnDescription: true,
        matchOnDetail: true,
      });

      if (selected) {
        await switchToConversation(outputChannel, selected.conversationId, selected.displayName);
      }
    }),
  );

  // Switch to conversation
  context.subscriptions.push(
    vscode.commands.registerCommand('conversationManager.switchTo', async (item?: { conversationId: string; displayName: string }) => {
      if (!item) { return; }
      if (switchInProgress) {
        outputChannel.appendLine('  Switch ignored: another switch is in progress.');
        return;
      }
      switchInProgress = true;
      try {
        await switchToConversation(outputChannel, item.conversationId, item.displayName);
      } finally {
        switchInProgress = false;
      }
    }),
  );

  // Refresh
  context.subscriptions.push(
    vscode.commands.registerCommand('conversationManager.refresh', () => { refreshAll(); }),
  );

  context.subscriptions.push(outputChannel);
  outputChannel.appendLine('Conversation Manager activated!');
}

export function deactivate() {}
