#!/usr/bin/env python3
"""
Extract per-conversation summaries from Antigravity's global state database.
Called by the conversation-manager extension to populate card previews.
Outputs JSON: { "cascadeId": "summary text", ... }
"""
import sqlite3
import base64
import json
import os
import re
import sys

DB = os.path.expanduser(
    "~/Library/Application Support/Antigravity/User/globalStorage/state.vscdb"
)

def extract_artifact_summaries():
    """Extract summaries from artifactReview (covers most conversations)."""
    result = {}
    if not os.path.exists(DB):
        return result

    conn = sqlite3.connect(DB)
    cur = conn.cursor()
    cur.execute(
        "SELECT value FROM ItemTable WHERE key = 'antigravityUnifiedStateSync.artifactReview'"
    )
    row = cur.fetchone()
    conn.close()
    if not row:
        return result

    try:
        decoded = base64.b64decode(row[0])
    except Exception:
        return result

    text = decoded.decode("utf-8", errors="replace")

    # Parse: each entry has a brain/UUID/file.md path + base64 artifactMetadata
    pattern = re.compile(
        r'brain/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/\w+\.md.*?"artifactMetadata":"([A-Za-z0-9+/=]+)"',
        re.DOTALL,
    )

    for match in pattern.finditer(text):
        conv_id = match.group(1)
        meta_b64 = match.group(2)
        try:
            meta_bytes = base64.b64decode(meta_b64)
            # Extract readable strings from protobuf
            strings = []
            current = []
            for b in meta_bytes:
                if b >= 32:
                    current.append(chr(b) if b < 128 else "?")
                else:
                    if len(current) >= 8:
                        strings.append("".join(current))
                    current = []
            if len(current) >= 8:
                strings.append("".join(current))

            if strings:
                best = max(strings, key=len).strip()
                # Keep the longest/most descriptive summary per conversation
                if conv_id not in result or len(best) > len(result[conv_id]):
                    result[conv_id] = best
        except Exception:
            pass

    return result


def extract_trajectory_names():
    """Extract TaskName from trajectorySummaries (for task-heavy conversations)."""
    result = {}
    if not os.path.exists(DB):
        return result

    conn = sqlite3.connect(DB)
    cur = conn.cursor()
    cur.execute(
        "SELECT value FROM ItemTable WHERE key = 'antigravityUnifiedStateSync.trajectorySummaries'"
    )
    row = cur.fetchone()
    conn.close()
    if not row:
        return result

    try:
        decoded = base64.b64decode(row[0])
    except Exception:
        return result

    # Extract UUID + the first inner base64 block after each UUID
    uuid_re = re.compile(
        rb"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"
    )
    inner_b64_re = re.compile(rb"[A-Za-z0-9+/]{30,}={0,2}")

    positions = [(m.start(), m.group(1).decode()) for m in uuid_re.finditer(decoded)]

    for idx, (pos, conv_id) in enumerate(positions):
        end = positions[idx + 1][0] if idx + 1 < len(positions) else len(decoded)
        region = decoded[pos:end]

        for block in inner_b64_re.findall(region):
            try:
                inner = base64.b64decode(block)
                strings = []
                current = []
                for b in inner:
                    if 32 <= b < 127:
                        current.append(chr(b))
                    else:
                        if len(current) >= 8:
                            strings.append("".join(current))
                        current = []
                if len(current) >= 8:
                    strings.append("".join(current))

                # Filter out tool-related strings
                good = [
                    s.strip()
                    for s in strings
                    if len(s.strip()) >= 10
                    and not s.startswith("toolu_")
                    and not s.startswith("file://")
                    and not s.startswith("secret://")
                    and not s.startswith("http")
                    and "vrtx" not in s
                    and "$" not in s[:3]
                ]
                if good and conv_id not in result:
                    result[conv_id] = good[0][:100]
            except Exception:
                continue

    return result


def main():
    # Merge both sources: artifact summaries take priority, trajectory names fill gaps
    artifact = extract_artifact_summaries()
    trajectory = extract_trajectory_names()

    merged = {}
    all_ids = set(artifact.keys()) | set(trajectory.keys())
    for cid in all_ids:
        a = artifact.get(cid, "")
        t = trajectory.get(cid, "")
        # Prefer artifact summary (more descriptive), fall back to trajectory name
        merged[cid] = a if a else t

    json.dump(merged, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
