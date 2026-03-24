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
