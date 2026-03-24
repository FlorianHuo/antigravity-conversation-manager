import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ConversationProvider } from './conversationProvider';
import { ConversationStore } from './conversationStore';
import { ConversationItem } from './conversationItem';

// Brain directory path
const BRAIN_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || '',
  '.gemini',
  'antigravity',
  'brain',
);

// Commands to try when focusing the Agent side panel (chat sidebar)
const AGENT_PANEL_FOCUS_COMMANDS = [
  'antigravity.openAgent',
  'antigravity.prioritized.chat.open',
  'antigravity.toggleChatFocus',
] as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Focus the Agent side panel so the conversation view is visible.
 * Returns the command that succeeded, or null.
 */
async function focusAgentPanel(outputChannel: vscode.OutputChannel): Promise<string | null> {
  const availableCommands = new Set(await vscode.commands.getCommands(true));

  for (const commandId of AGENT_PANEL_FOCUS_COMMANDS) {
    if (!availableCommands.has(commandId)) {
      continue;
    }

    try {
      outputChannel.appendLine(`  Focusing Agent panel via ${commandId}...`);
      await vscode.commands.executeCommand(commandId);
      return commandId;
    } catch (error) {
      outputChannel.appendLine(`  ${commandId} failed: ${error}`);
    }
  }

  outputChannel.appendLine(
    `  Warning: no Agent panel focus command succeeded.`,
  );
  return null;
}

/**
 * Switch to a conversation by calling our patched command
 * `antigravity.switchConversation` which directly invokes
 * togglePanelTab('conversation', cascadeId) on the
 * workbenchServiceProvider, bypassing the Manager window.
 */
async function switchToConversation(
  outputChannel: vscode.OutputChannel,
  cascadeId: string,
  displayName: string,
): Promise<void> {
  outputChannel.appendLine(`\n=== Switching to: ${cascadeId} (${displayName}) ===`);

  try {
    await vscode.commands.executeCommand('antigravity.switchConversation', cascadeId);
    outputChannel.appendLine('  Switch successful via antigravity.switchConversation');
  } catch (err) {
    outputChannel.appendLine(`  switchConversation failed: ${err}`);
    // Fallback: try forceFocusManager + openAgent
    outputChannel.appendLine('  Falling back to forceFocusManager...');
    try {
      await vscode.commands.executeCommand('workbench.action.forceFocusManager', cascadeId);
      await sleep(400);
      await focusAgentPanel(outputChannel);
    } catch (fallbackErr) {
      outputChannel.appendLine(`  Fallback also failed: ${fallbackErr}`);
    }
  }

  outputChannel.appendLine('=== Switch completed ===');
}

export function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel('Conversation Manager');
  outputChannel.appendLine('Conversation Manager activating...');
  let switchInProgress = false;

  // Initialize the metadata store
  const store = new ConversationStore(context.globalStorageUri.fsPath);

  // Create tree data providers for pinned and recent sections
  const pinnedProvider = new ConversationProvider(store, true);
  const recentProvider = new ConversationProvider(store, false);

  // Register tree views
  const pinnedView = vscode.window.createTreeView('conversationManager.pinnedList', {
    treeDataProvider: pinnedProvider,
    showCollapseAll: false,
  });

  const recentView = vscode.window.createTreeView('conversationManager.recentList', {
    treeDataProvider: recentProvider,
    showCollapseAll: false,
  });

  // Helper to refresh both views
  function refreshAll() {
    pinnedProvider.refresh();
    recentProvider.refresh();
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

  // New conversation: delegate to Antigravity's internal command
  context.subscriptions.push(
    vscode.commands.registerCommand('conversationManager.newConversation', async () => {
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
      setTimeout(refreshAll, 1000);
    }),
  );

  // Open a QuickPick to search and switch conversations
  context.subscriptions.push(
    vscode.commands.registerCommand('conversationManager.openPicker', async () => {
      const allItems = [
        ...await pinnedProvider.getChildren(),
        ...await recentProvider.getChildren(),
      ];

      const picks = allItems.map((c) => ({
        label: `${c.isPinned ? '$(pin) ' : ''}${c.displayName}`,
        description: c.conversationId.slice(0, 8),
        detail: c.lastModified
          ? `Last active: ${new Date(c.lastModified).toLocaleString()}`
          : undefined,
        conversationId: c.conversationId,
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

  // Switch to a specific conversation
  context.subscriptions.push(
    vscode.commands.registerCommand('conversationManager.switchTo', async (item?: ConversationItem) => {
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
      } finally {
        switchInProgress = false;
      }
    }),
  );

  // Rename a conversation
  context.subscriptions.push(
    vscode.commands.registerCommand('conversationManager.rename', async (item?: ConversationItem) => {
      if (!item) {
        return;
      }
      const newName = await vscode.window.showInputBox({
        prompt: 'Enter a new name for this conversation',
        value: item.displayName,
        placeHolder: 'Conversation name',
      });
      if (newName !== undefined && newName.trim().length > 0) {
        store.rename(item.conversationId, newName.trim());
        refreshAll();
        outputChannel.appendLine(`Renamed ${item.conversationId} to "${newName.trim()}"`);
      }
    }),
  );

  // Pin a conversation
  context.subscriptions.push(
    vscode.commands.registerCommand('conversationManager.pin', async (item?: ConversationItem) => {
      if (!item) {
        return;
      }
      store.pin(item.conversationId);
      refreshAll();
      outputChannel.appendLine(`Pinned: ${item.conversationId}`);
    }),
  );

  // Unpin a conversation
  context.subscriptions.push(
    vscode.commands.registerCommand('conversationManager.unpin', async (item?: ConversationItem) => {
      if (!item) {
        return;
      }
      store.unpin(item.conversationId);
      refreshAll();
      outputChannel.appendLine(`Unpinned: ${item.conversationId}`);
    }),
  );

  // Delete a conversation (with confirmation)
  context.subscriptions.push(
    vscode.commands.registerCommand('conversationManager.deleteConversation', async (item?: ConversationItem) => {
      if (!item) {
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        `Delete conversation "${item.displayName}"?\n\nThis will permanently delete the conversation data.`,
        { modal: true },
        'Delete',
      );
      if (confirm === 'Delete') {
        const dirPath = path.join(BRAIN_DIR, item.conversationId);
        try {
          fs.rmSync(dirPath, { recursive: true, force: true });
          store.deleteMetadata(item.conversationId);
          refreshAll();
          outputChannel.appendLine(`Deleted: ${item.conversationId}`);
          vscode.window.showInformationMessage(`Conversation "${item.displayName}" deleted.`);
        } catch (err) {
          vscode.window.showErrorMessage(`Failed to delete conversation: ${err}`);
        }
      }
    }),
  );

  // Copy conversation ID
  context.subscriptions.push(
    vscode.commands.registerCommand('conversationManager.copyId', async (item?: ConversationItem) => {
      if (!item) {
        return;
      }
      await vscode.env.clipboard.writeText(item.conversationId);
      vscode.window.showInformationMessage(`Copied: ${item.conversationId}`);
    }),
  );

  // Refresh
  context.subscriptions.push(
    vscode.commands.registerCommand('conversationManager.refresh', () => {
      refreshAll();
    }),
  );

  // Cleanup
  context.subscriptions.push(pinnedView, recentView, outputChannel);

  outputChannel.appendLine('Conversation Manager activated!');
}

export function deactivate() {}
