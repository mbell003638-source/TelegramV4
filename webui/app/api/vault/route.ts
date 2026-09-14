import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { getVaultPath, ensureVaultStructure } from '@/lib/obsidian';

export async function GET(req: NextRequest) {
  try {
    const vaultPath = getVaultPath();
    const agenticOsRoot = ensureVaultStructure(vaultPath);

    const { searchParams } = new URL(req.url);
    const subPath = searchParams.get('path'); // relative to vault

    if (subPath) {
      const fullPath = path.resolve(vaultPath, subPath);
      // Security check: ensure path is within vault
      if (!fullPath.startsWith(path.resolve(vaultPath))) {
        return NextResponse.json({ ok: false, error: 'Access denied' }, { status: 403 });
      }

      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
        const content = fs.readFileSync(fullPath, 'utf8');
        return NextResponse.json({ ok: true, path: subPath, content });
      }
      return NextResponse.json({ ok: false, error: 'File not found' }, { status: 404 });
    }

    // List all markdown files in Agentic OS root
    const items: Array<{ name: string; relativePath: string; category: string; mtime: number; size: number }> = [];

    const scanDir = (dir: string, category: string): void => {
      if (!fs.existsSync(dir)) return;
      const files = fs.readdirSync(dir);
      for (const f of files) {
        const full = path.join(dir, f);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          scanDir(full, f);
        } else if (f.endsWith('.md')) {
          const rel = path.relative(vaultPath, full).replace(/\\/g, '/');
          items.push({
            name: f,
            relativePath: rel,
            category,
            mtime: stat.mtimeMs,
            size: stat.size,
          });
        }
      }
    }

    scanDir(agenticOsRoot, 'Agentic OS');

    // Sort by modification time desc
    items.sort((a, b) => b.mtime - a.mtime);

    return NextResponse.json({
      ok: true,
      vaultPath,
      items,
    });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
