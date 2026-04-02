import * as fs from 'fs';
import * as path from 'path';

export function getLastUserPrompt(dirPath: string): string | undefined {
  try {
    const msgPath = path.join(dirPath, '.system_generated', 'messages');
    if (!fs.existsSync(msgPath)) return undefined;
    
    let lastTime = 0;
    let lastContent: string | undefined = undefined;

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
    return lastContent;
  } catch {
    return undefined;
  }
}
