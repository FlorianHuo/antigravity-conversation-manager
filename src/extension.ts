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

  // Helper to get current workspace path
  function getCurrentWorkspace(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  // Helper to refresh UI
  function refreshAll() {
    webviewProvider.refresh();
  }

  // Watch the brain directory for UI refreshes only (no auto-association)
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
      // Record brain dir state BEFORE creating new conversation
      const beforeIds = new Set<string>();
      if (fs.existsSync(BRAIN_DIR)) {
        for (const e of fs.readdirSync(BRAIN_DIR, { withFileTypes: true })) {
          if (e.isDirectory()) { beforeIds.add(e.name); }
        }
      }

      try {
        await vscode.commands.executeCommand('antigravity.startNewConversation');
        outputChannel.appendLine('Started new conversation via antigravity.startNewConversation');
      } catch {
        try {
          await vscode.commands.executeCommand('antigravity.prioritized.chat.openNewConversation');
          outputChannel.appendLine('Started new conversation via prioritized.chat.openNewConversation');
        } catch {
          try {
            await vscode.commands.executeCommand('workbench.action.chat.newChat');
            outputChannel.appendLine('Started new conversation via workbench.action.chat.newChat');
          } catch (err) {
            vscode.window.showErrorMessage(`Failed to create new conversation: ${err}`);
          }
        }
      }

      // After creating, find the new dir and associate with this workspace
      setTimeout(() => {
        const ws = getCurrentWorkspace();
        if (ws && fs.existsSync(BRAIN_DIR)) {
          for (const e of fs.readdirSync(BRAIN_DIR, { withFileTypes: true })) {
            if (e.isDirectory() && !beforeIds.has(e.name)) {
              store.associateWorkspace(e.name, ws);
              outputChannel.appendLine(`Associated new ${e.name.substring(0, 8)} with ${path.basename(ws)}`);
            }
          }
        }
        refreshAll();
      }, 1000);
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
