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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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

  // Primary: patched workbench command
  if (availableCommands.has('antigravity.switchConversation')) {
    try {
      await vscode.commands.executeCommand(
        'antigravity.switchConversation',
        conversationId,
      );
      outputChannel.appendLine('  Switch successful via antigravity.switchConversation');
      outputChannel.appendLine('=== Switch completed ===');
      return;
    } catch (error) {
      outputChannel.appendLine(`  antigravity.switchConversation failed: ${error}`);
    }
  }

  // Fallback: open the Agent panel, then use the internal focus manager
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

// Flag to prevent concurrent switches
let switchInProgress = false;

export function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel('Conversation Manager');
  outputChannel.appendLine('Conversation Manager activating...');

  // Initialize store
  const store = new ConversationStore(
    context.globalStorageUri.fsPath,
  );

  // Register WebviewView provider
  const webviewProvider = new ConversationWebviewProvider(context.extensionUri, store);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ConversationWebviewProvider.viewType,
      webviewProvider,
    ),
  );

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // Helper to get current workspace path
  function getCurrentWorkspace(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  // Associate very new dirs (< 10s) with current workspace
  function associateNewDirs() {
    const ws = getCurrentWorkspace();
    if (!ws || !fs.existsSync(BRAIN_DIR)) { return; }
    const now = Date.now();
    try {
      for (const e of fs.readdirSync(BRAIN_DIR, { withFileTypes: true })) {
        if (!e.isDirectory() || !UUID_RE.test(e.name)) { continue; }
        if (store.getWorkspace(e.name)) { continue; }
        try {
          const stat = fs.statSync(path.join(BRAIN_DIR, e.name));
          if (now - stat.birthtimeMs < 10_000) {
            store.associateWorkspace(e.name, ws);
            outputChannel.appendLine(`Associated ${e.name.substring(0, 8)} with ${path.basename(ws)}`);
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  // Helper to refresh UI
  function refreshAll() {
    associateNewDirs();
    webviewProvider.refresh();
  }

  // Watch the brain directory for changes
  if (fs.existsSync(BRAIN_DIR)) {
    try {
      const watcher = fs.watch(BRAIN_DIR, { persistent: false }, () => {
        refreshAll();
      });
      context.subscriptions.push({ dispose: () => watcher.close() });
    } catch (err) {
      outputChannel.appendLine(`Warning: could not watch brain directory: ${err}`);
    }
  }

  // ---- Commands ----

  // New conversation
  context.subscriptions.push(
    vscode.commands.registerCommand('conversationManager.newConversation', async () => {
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
      // Retry to catch the new dir (watcher may also catch it)
      setTimeout(refreshAll, 500);
      setTimeout(refreshAll, 2000);
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

  // Switch to a specific conversation (accepts from webview or tree)
  context.subscriptions.push(
    vscode.commands.registerCommand('conversationManager.switchTo', async (item?: { conversationId: string; displayName: string }) => {
      if (!item) {
        return;
      }

      if (switchInProgress) {
        outputChannel.appendLine('  Switch ignored: another switch is in progress.');
        return;
      }

      switchInProgress = true;

      try {
        await switchToConversation(outputChannel, item.conversationId, item.displayName);
        // Associate this conversation with current workspace on explicit switch
        const ws = getCurrentWorkspace();
        if (ws) {
          store.associateWorkspace(item.conversationId, ws);
        }
      } finally {
        switchInProgress = false;
      }
    }),
  );

  // Refresh
  context.subscriptions.push(
    vscode.commands.registerCommand('conversationManager.refresh', () => {
      refreshAll();
    }),
  );


  // Cleanup
  context.subscriptions.push(outputChannel);

  outputChannel.appendLine('Conversation Manager activated!');
}

export function deactivate() {}
