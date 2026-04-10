import * as fs from 'fs';
import * as path from 'path';

export function getLastUserPrompt(dirPath: string): string | undefined {
  try {
    const msgPath = path.join(dirPath, '.system_generated', 'messages');
    let lastContent: string | undefined = undefined;

    if (fs.existsSync(msgPath)) {
      let lastTime = 0;
      const files = fs.readdirSync(msgPath).filter(f => f.endsWith('.json'));
      for (const f of files) {
        try {
          const filePath = path.join(msgPath, f);
          const stat = fs.statSync(filePath);
          const content = fs.readFileSync(filePath, 'utf-8');
          const data = JSON.parse(content);
          if (data.sender === 'user' && data.content && typeof data.content === 'string') {
            if (stat.mtimeMs > lastTime) {
              lastTime = stat.mtimeMs;
              let text = data.content.substring(0, 100).replace(/\n/g, ' ');
              if (data.content.length > 100) text += '...';
              lastContent = text;
            }
          }
        } catch { /* skip */ }
      }
      if (lastContent) return lastContent;
    }

    const logsPath = path.join(dirPath, '.system_generated', 'logs', 'overview.txt');
    if (fs.existsSync(logsPath)) {
      try {
        const content = fs.readFileSync(logsPath, 'utf-8');
        const match = content.match(/USER(?: Objective)?:\s*([^\n]+)/i);
        if (match) {
           let text = match[1].trim().substring(0, 100);
           if (match[1].length > 100) text += '...';
           return text;
        }
      } catch { /* skip */ }
    }

    return undefined;
  } catch {
    return undefined;
  }
}
