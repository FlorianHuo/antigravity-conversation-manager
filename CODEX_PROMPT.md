# Task: Fix Direct Conversation Switching in Antigravity Extension

## Context

I'm building a VS Code extension for **Antigravity** (Google's AI IDE, a VS Code fork) that adds a sidebar TreeView listing AI conversations. The extension works -- it shows conversations in the sidebar. But **clicking a conversation should directly switch to it in the Agent Side Panel** (the right-side AI chat panel), and this doesn't work yet.

Currently, clicking a conversation either:
- Opens the Agent Manager panel but does NOT switch to the specific conversation
- Or opens a QuickPick conversation picker (fallback)

## Project Location

`/Users/florian/Documents/Projects/antigravity-conversation-manager/`

Key files:
- `src/extension.ts` -- Entry point, all commands
- `src/conversationProvider.ts` -- TreeView data provider
- `src/conversationStore.ts` -- Metadata persistence (JSON)
- `src/conversationItem.ts` -- TreeItem (click triggers `conversationManager.switchTo`)
- `scripts/deploy.sh` -- Deploys to `~/.antigravity/extensions/`

## How Antigravity Stores Conversations

Conversations are stored as UUID directories under `~/.gemini/antigravity/brain/`:
```
~/.gemini/antigravity/brain/
  337e81bc-276c-4bac-9f2c-4d5fb0534241/
    task.md
    implementation_plan.md
    .system_generated/steps/...
```

Internally, Antigravity calls conversations **"cascades"**. The conversation UUID = `cascadeId`.

## Reverse Engineering Findings (from workbench.desktop.main.js)

The Antigravity workbench JS is at:
`/Applications/Antigravity.app/Contents/Resources/app/out/vs/workbench/workbench.desktop.main.js`

### Key Internal APIs Found

#### 1. `workbench.action.forceFocusManager` (TRIED -- does NOT switch conversation)
```js
_i.registerCommand({
  id: "workbench.action.forceFocusManager",
  handler: async(t, e) => {
    const i = t.get(g9), n = t.get(BQ), s = t.get(tn);
    if (await i.materializeAndFocus(tT.Manager, {force: true}),
        e && typeof e === "string")
      await n.callManagerRpc("openConversationView", {cascadeId: e});
    else {
      const r = lj(s.getWorkspace());
      if (!r) return;
      await n.callManagerRpc("openConversationView", {workspaceUri: r.toString()});
    }
  }
});
```
**Result**: Focuses the Agent Manager but the RPC `openConversationView` doesn't actually switch the conversation. Possibly a timing issue (webview not ready).

#### 2. `workbench.action.focusAgentManager.continueConversation` (TRIED -- does NOT switch)
```js
// This command does NOT pass the argument through. It uses getActiveCascadeId() instead:
let o;
i || (o = e.get(Mv).getActiveCascadeId());
await e.get(g9).materializeAndFocus(tT.Manager);
const l = {workspaceUri: r, ...o && {cascadeId: o}};
n.callManagerRpc("openConversationView", l);
```
**Result**: Opens Agent Manager, ignores the passed argument, uses current active cascadeId.

#### 3. `setVisibleConversation` (internal RPC handler, not a command)
```js
async setVisibleConversation(e) {
  return this.P.togglePanelTab?.("conversation", e.cascadeId), {};
}
```
This is the actual mechanism that switches conversations. It's called as an RPC from the renderer webview, NOT as a VS Code command. `togglePanelTab("conversation", cascadeId)` is the real switch function.

#### 4. `setCascadeId` (React event in the Agent webview)
```js
// Inside the React app of the agent panel:
startNewConversation: Zt(() => {
  t(void 0);  // setCascadeId(undefined) starts new conversation
  i(vse("conversation"));
  // ...
})

// When selecting from conversation picker:
openConversationWorkspaceQuickPick(...)
  .then(E => { E?.openInCurrentWindow && o(b) })  // o = setCascadeId
```
The picker calls `setCascadeId(cascadeId)` when "Open in current window" is selected.

#### 5. `conversationPicker.showConversationPicker` (command)
```js
class VWd extends Ie {
  constructor() {
    super({
      id: "conversationPicker.showConversationPicker",
      title: "Show Conversation Picker",
      category: "Jetski"
    });
  }
  async run(t, e) {
    const n = await IP(lwt.ID).show(n_t(HXo, e));
    return Lqi(JYt, n);
  }
}
```
This shows the overlay conversation picker UI. It accepts protobuf-encoded arguments.

#### 6. Other Available Commands
```
antigravity.openChatView          -- Opens the chat side panel
antigravity.openConversationPicker -- Opens built-in picker
antigravity.openConversationWorkspaceQuickPick -- Workspace-scoped picker
antigravity.startNewConversation  -- Creates new conversation
antigravity.reloadAgentSidePanel  -- Reloads the side panel
workbench.action.smartFocusConversation -- Focuses MRU window
```

## The Core Problem

The conversation switch mechanism (`setCascadeId` / `togglePanelTab`) lives inside the Agent webview (React app), which communicates with the host via RPC. VS Code extension APIs cannot directly:
1. Call functions inside the webview's React state management
2. Invoke the `togglePanelTab` service method
3. Set the React state's `cascadeId`

The `callManagerRpc("openConversationView", {cascadeId})` should work in theory, but in practice seems to either:
- Not reach the webview
- Reach it before the webview is ready
- Get silently ignored

## What I Need

Find a way to make clicking a conversation in the sidebar TreeView **directly switch to that conversation** in the Agent Side Panel. Possible approaches:

1. **Fix the RPC timing**: Maybe `callManagerRpc` needs to wait for the webview to be ready. Add a delay after `materializeAndFocus` before calling the RPC?

2. **Use a different command chain**: Maybe there's a command I haven't found that properly handles the full flow.

3. **Webview message passing**: Is there a way for an extension to send a message to a specific webview (the Agent Manager webview)?

4. **Workspace QuickPick with auto-selection**: The `openConversationWorkspaceQuickPick` opens a picker -- can we programmatically select an item in it?

5. **Keyboard simulation**: Open the picker, then simulate typing/selecting the target conversation.

6. **Direct webview DOM manipulation**: Extensions can't normally do this, but maybe Antigravity has a special API.

## Development Workflow

```bash
cd ~/Documents/Projects/antigravity-conversation-manager
npm run compile          # Compile TypeScript
./scripts/deploy.sh      # Deploy to ~/.antigravity/extensions/
# Then Cmd+Shift+P > Reload Window in Antigravity
```

Check Output Channel "Conversation Manager" for debug logs.

## Current extension.ts switchTo Implementation

```typescript
vscode.commands.registerCommand('conversationManager.switchTo', async (item?: ConversationItem) => {
  if (!item) return;
  const cascadeId = item.conversationId;
  
  // This focuses Agent Manager but does NOT switch conversation:
  await vscode.commands.executeCommand('workbench.action.forceFocusManager', cascadeId);
  
  // Fallback: opens picker UI
  await vscode.commands.executeCommand('antigravity.openConversationWorkspaceQuickPick', { workspaceUris });
});
```
