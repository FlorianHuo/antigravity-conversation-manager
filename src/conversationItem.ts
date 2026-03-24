import * as vscode from 'vscode';

// Represents a single conversation item in the TreeView
export class ConversationItem extends vscode.TreeItem {
  constructor(
    public readonly conversationId: string,
    public readonly displayName: string,
    public readonly lastModified: number,
    public readonly isPinned: boolean,
    public readonly summary?: string,
  ) {
    super(displayName, vscode.TreeItemCollapsibleState.None);

    // Description: just relative time (summary in tooltip on hover)
    this.description = ConversationItem.formatRelativeTime(lastModified);

    // Rich tooltip with full summary
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

    // Icon based on pin status
    this.iconPath = isPinned
      ? new vscode.ThemeIcon('pinned', new vscode.ThemeColor('charts.yellow'))
      : new vscode.ThemeIcon('comment-discussion');

    // Context value for menu filtering
    this.contextValue = isPinned ? 'pinnedConversation' : 'conversation';

    // Click to switch
    this.command = {
      command: 'conversationManager.switchTo',
      title: 'Switch to Conversation',
      arguments: [this],
    };
  }

  // Format a timestamp as relative time (e.g., "2h ago", "3d ago")
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
