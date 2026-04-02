# Project: antigravity-conversation-manager

A VS Code extension that manages AI conversations in the Antigravity sidebar.

## Architecture

- **Data source**: `~/.gemini/antigravity/brain/` — each conversation is a UUID directory containing artifacts (`.md`, `.resolved`, `.metadata.json`) and `.system_generated/messages/*.json`
- **Store**: `ConversationStore` persists metadata (names, pins, workspace, order) as JSON in VS Code globalStorage
- **UI**: Sidebar webview (`ConversationWebviewProvider`) renders HTML cards with drag-and-drop, rename, remove, delete
- **Workspace scoping**: Conversations filtered by explicit association OR content matching (scanning artifacts for workspace path)

## Key files

| File | Role |
|------|------|
| `src/extension.ts` | Activation, all commands (new, add, switch, picker), fs watcher |
| `src/conversationStore.ts` | JSON-backed metadata (pin, rename, workspace, order) |
| `src/conversationWebviewProvider.ts` | Webview HTML rendering, conversation listing, auto-naming, summary extraction |
| `src/lastPromptExtractor.ts` | Extracts last user message from `.system_generated/messages/` |
| `src/conversationProvider.ts` | Legacy TreeDataProvider (unused, kept for reference) |
| `src/conversationItem.ts` | Legacy TreeItem classes (unused) |

## Development workflow

```bash
npm run compile   # TypeScript -> out/
npm run deploy    # Compile + copy to ~/.antigravity/extensions/
# Then: Cmd+Shift+P -> "Reload Window" in Antigravity
```

## Mandatory rules for making changes

### 1. Understand before changing
- ALWAYS read the full file before modifying it. Do not guess function signatures, variable names, or control flow.
- Trace data flow end-to-end: where does the data come from? Where is it consumed? What other callers exist?

### 2. Test with real data before declaring done
- After any change, run `npm run compile` and verify it succeeds with zero errors.
- For content-matching or filtering logic, test against REAL brain directories:
  ```bash
  # Count how many conversations match / don't match
  for id in $(ls ~/.gemini/antigravity/brain/); do
    dir=~/.gemini/antigravity/brain/$id
    # ... verify your logic against actual directory contents
  done
  ```
- For QuickPick / UI changes, describe what the user will see. Think about edge cases:
  - Empty conversations (no files at all)
  - Conversations with only images (no text to match)
  - Conversations explicitly removed from a workspace (`workspace: ""` in store)

### 3. JavaScript/TypeScript gotchas to watch for
- **Falsy strings**: `""` is falsy in JS. `if (str)` will skip empty strings. Use `str !== undefined` when you need to distinguish "not set" from "explicitly empty".
- **Substring matching**: `"foo".includes("fo")` is true. When matching workspace names in file content, use word boundaries or the full path. The basename of a workspace (e.g. `antigravity-conversation-manager`) can substring-match unrelated content (e.g. `conversation-manager`).
- **`fs.existsSync` + `fs.readdirSync`**: Always handle the case where a directory is empty or only contains `.system_generated/`.

### 4. Common pitfalls in this codebase
- Many conversations in `brain/` are **empty** (66 out of 102). Always filter these out when listing candidates.
- Most conversations have **no text referencing the workspace path**. Content matching is a heuristic, not reliable. Do not rely on it as the sole signal.
- The `.system_generated/messages/` folder contains JSON with `{ sender, content }`. Only `sender: "user"` messages have useful content. System messages are restart notices.
- Artifact files (`.md`, `.resolved`) may reference paths from OTHER workspaces. A conversation about project A can mention project B's path.

### 5. Commit discipline
- Make small, focused changes. One logical change per iteration.
- After each change, compile AND manually verify the behavior makes sense.
- Do not "fix" things that aren't broken. Do not refactor adjacent code.
