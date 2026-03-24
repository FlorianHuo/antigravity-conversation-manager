# Antigravity Conversation Manager

Manage multiple AI conversations from the Antigravity sidebar.

## Features

- **Sidebar TreeView** with all conversations, sorted by recency
- **Pinned conversations** section for quick access
- **Auto-naming** from task.md / implementation_plan.md titles
- **Custom renaming** via right-click menu
- **New conversation** button ("+") in the sidebar header
- **Quick switch** by clicking any conversation
- **Delete** conversations with confirmation
- **File watcher** auto-refreshes when conversations change

## Keybindings

| Shortcut | Action |
|----------|--------|
| `Cmd+Shift+N` | New Conversation |
| `Cmd+Shift+H` | Open Conversation Picker |

## Development

```bash
npm install
npm run compile
./scripts/deploy.sh
```

Then reload the Antigravity window (`Cmd+Shift+P` > "Reload Window").

## Workbench Patch

After each Antigravity update, re-apply the workbench patch:

```bash
python scripts/patch_workbench.py
```

This injects the `antigravity.switchConversation` command and suppresses the integrity warning.

To restore original files: `python scripts/patch_workbench.py --restore`

## Changelog

### v0.1.0

- Sidebar TreeView with pinned/recent conversations
- Direct conversation switching via patched `antigravity.switchConversation` command
- Workbench patch script (`scripts/patch_workbench.py`) with integrity warning suppression
- Auto-naming from task.md / implementation_plan.md titles
- Rename, delete, copy ID via context menu
- Keybindings: `Cmd+Shift+N` (new), `Cmd+Shift+H` (picker)
