#!/usr/bin/env python3
"""
Patch Antigravity's workbench.desktop.main.js to inject the
`antigravity.switchConversation` command.

This command directly fires the togglePanelTabEvent (which triggers
setCascadeId in React) and then opens the panel after 50ms, matching
the internal picker's sequencing.

Usage: python scripts/patch_workbench.py
       python scripts/patch_workbench.py --restore   # restore from backup

Re-run after every Antigravity update.
"""
import hashlib
import base64
import json
import shutil
import os
import sys

WORKBENCH = '/Applications/Antigravity.app/Contents/Resources/app/out/vs/workbench/workbench.desktop.main.js'
BACKUP = WORKBENCH + '.bak'
PRODUCT = '/Applications/Antigravity.app/Contents/Resources/app/product.json'
CHECKSUM_KEY = 'vs/workbench/workbench.desktop.main.js'

# Anchor: the end of the existing "open customizations tab" command
ANCHOR = 't.get(jz).togglePanelTab?.("customization")}});'

# Injected command: fires event first (setCascadeId), then openPanel after 50ms
INJECTION = (
    'ge(class extends Ie{constructor(){super({id:"antigravity.switchConversation",'
    'title:"Switch Conversation",f1:!1})}async run(t,e){'
    'var s=t.get(jz);s.c.fire({tab:"conversation",cascadeId:e});'
    'setTimeout(function(){s.openPanel()},50)}});'
)


def compute_checksum(filepath):
    """Compute base64-encoded SHA256 checksum."""
    with open(filepath, 'rb') as f:
        sha = hashlib.sha256(f.read()).digest()
    return base64.b64encode(sha).decode()


def update_product_checksum(new_checksum):
    """Update the checksum in product.json to suppress integrity warning."""
    with open(PRODUCT, 'r') as f:
        data = json.load(f)

    old = data.get('checksums', {}).get(CHECKSUM_KEY, '(not found)')
    data.setdefault('checksums', {})[CHECKSUM_KEY] = new_checksum

    with open(PRODUCT, 'w') as f:
        json.dump(data, f, indent='\t', ensure_ascii=False)
        f.write('\n')

    print(f'  Checksum updated: {old[:20]}... -> {new_checksum[:20]}...')


def restore():
    """Restore workbench from backup."""
    if not os.path.exists(BACKUP):
        print('ERROR: No backup found.')
        sys.exit(1)
    shutil.copy2(BACKUP, WORKBENCH)
    new_checksum = compute_checksum(WORKBENCH)
    update_product_checksum(new_checksum)
    print('Restored from backup. Reload Antigravity window.')


def patch():
    """Apply the patch."""
    with open(WORKBENCH, 'r', errors='replace') as f:
        content = f.read()

    # Check if already patched
    if 'antigravity.switchConversation' in content:
        print('Already patched!')
        # Still update checksum in case product.json was reset
        new_checksum = compute_checksum(WORKBENCH)
        update_product_checksum(new_checksum)
        return

    # Verify anchor exists
    idx = content.find(ANCHOR)
    if idx < 0:
        print('ERROR: Anchor not found. Antigravity may have been updated.')
        print('  Try restoring first: python scripts/patch_workbench.py --restore')
        sys.exit(1)

    # Create backup
    if not os.path.exists(BACKUP):
        shutil.copy2(WORKBENCH, BACKUP)
        print(f'Backup: {BACKUP}')

    # Inject after the anchor
    insert_pos = idx + len(ANCHOR)
    new_content = content[:insert_pos] + INJECTION + content[insert_pos:]

    with open(WORKBENCH, 'w') as f:
        f.write(new_content)

    # Suppress the integrity check warning notification
    _suppress_integrity_warning()

    # Update checksum
    new_checksum = compute_checksum(WORKBENCH)
    update_product_checksum(new_checksum)

    print('Patch applied successfully!')
    print('  Command: antigravity.switchConversation')
    print('  Integrity warning: suppressed')
    print('  Reload Antigravity window to activate.')


def _suppress_integrity_warning():
    """
    Replace the integrity warning notification call this.n()
    with void 0 so it never shows the 'installation corrupt' prompt.
    """
    import subprocess
    subprocess.run([
        'sed', '-i', '',
        r's/i?.dontShowPrompt\&\&i.commit===this.f.commit||this.n()/i?.dontShowPrompt\&\&i.commit===this.f.commit||void 0/g',
        WORKBENCH,
    ], check=True)


if __name__ == '__main__':
    if '--restore' in sys.argv:
        restore()
    else:
        patch()
