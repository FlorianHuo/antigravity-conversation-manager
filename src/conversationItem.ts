import * as vscode from 'vscode';

// Represents a conversation in the TreeView (expandable parent node)
export class ConversationItem extends vscode.TreeItem {
  constructor(
    public readonly conversationId: string,
    public readonly displayName: string,
    public readonly lastModified: number,
    public readonly isPinned: boolean,
    public readonly summary?: string,
  ) {
    // If there's a summary, make it expandable; otherwise flat
    super(
      displayName,
      summary
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );

    // Description: relative time
    this.description = ConversationItem.formatRelativeTime(lastModified);

    // Tooltip: full info
    const tooltipLines = [
      `**${displayName}**`,
      '',
      `ID: \`${conversationId}\``,
      '',
      `Last active: ${new Date(lastModified).toLocaleString()}`,
    ];
    if (summary) {
      tooltipLines.push('', '---', '', summary);
    }
    if (isPinned) {
      tooltipLines.push('', '$(pin) Pinned');
    }
    this.tooltip = new vscode.MarkdownString(tooltipLines.join('\n'));

    // Icon
    this.iconPath = isPinned
      ? new vscode.ThemeIcon('pinned', new vscode.ThemeColor('charts.yellow'))
      : new vscode.ThemeIcon('comment-discussion');

    // Context for right-click menus
    this.contextValue = isPinned ? 'pinnedConversation' : 'conversation';

    // Click to switch (only if no children, otherwise toggle expand)
    if (!summary) {
      this.command = {
        command: 'conversationManager.switchTo',
        title: 'Switch to Conversation',
        arguments: [this],
      };
    }
  }

  static formatRelativeTime(timestamp: number): string {
    const now = Date.now();
    const diffMs = now - timestamp;
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHr = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHr / 24);

    if (diffMin < 1) {
      return 'just now';
    }
    if (diffMin < 60) {
      return `${diffMin}m ago`;
    }
    if (diffHr < 24) {
      return `${diffHr}h ago`;
    }
    if (diffDay < 30) {
      return `${diffDay}d ago`;
    }
    return new Date(timestamp).toLocaleDateString();
  }
}

// Child item showing summary text under an expanded conversation
export class ConversationDetailItem extends vscode.TreeItem {
  public readonly parentItem: ConversationItem;

  constructor(parent: ConversationItem, summary: string) {
    super(summary, vscode.TreeItemCollapsibleState.None);
    this.parentItem = parent;
    this.iconPath = new vscode.ThemeIcon('info');
    this.contextValue = 'conversationDetail';

    // Click on summary line also switches to that conversation
    this.command = {
      command: 'conversationManager.switchTo',
      title: 'Switch to Conversation',
      arguments: [parent],
    };
  }
}
