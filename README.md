# Antigravity Conversation Manager

Manage multiple AI conversations from the Antigravity sidebar.

## Features

- **Sidebar cards** with drag-and-drop reordering
- **+ New** creates a conversation and auto-associates with current workspace
- **+ Add** auto-detects current active conversation and adds to sidebar
- **Auto-naming** from task.md / implementation_plan.md / metadata titles
- **Custom renaming** via pencil icon on hover
- **Remove / Delete** -- hide from sidebar or permanently delete
- **Quick switch** by clicking any card
- **Last activity time** on each card
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

### v0.2.0

- **Drag-and-drop** card reordering (replaces up/down arrows)
- **+ Add** auto-detects current conversation (no more QuickPick)
- **+ New** watcher-based detection (60s window for late brain-dir creation)
- **Last activity time** on cards (scans file mtimes, not dir mtime)
- **Remove** works reliably (explicit `workspace=''` marker)
- **Workspace filtering** via content-match (scans all text files in brain dir)
- Removed Refresh button (fs.watch handles auto-refresh)

### v0.1.0

- Sidebar TreeView with pinned/recent conversations
- Direct conversation switching via patched `antigravity.switchConversation` command
- Workbench patch script (`scripts/patch_workbench.py`) with integrity warning suppression
- Auto-naming from task.md / implementation_plan.md titles
- Rename, delete, copy ID via context menu
- Keybindings: `Cmd+Shift+N` (new), `Cmd+Shift+H` (picker)
