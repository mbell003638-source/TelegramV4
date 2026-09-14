import { NextResponse } from 'next/server';
import { getKanbanTasks, saveKanbanTasks, KanbanTask } from '@/lib/obsidian';

export async function GET(request: Request) {
  try {
    const tasks = getKanbanTasks();
    return NextResponse.json({ ok: true, tasks });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const tasks = getKanbanTasks();

    if (body.action === 'auto_assign_all') {
      // Auto assign rules based on keywords
      const updated = tasks.map(t => {
        const text = `${t.title} ${t.description}`.toLowerCase();
        let agent = 'claude';
        if (text.includes('code') || text.includes('3d') || text.includes('webgl') || text.includes('build') || text.includes('fix')) {
          agent = 'antigravity';
        } else if (text.includes('tool') || text.includes('standup') || text.includes('voice') || text.includes('exec') || text.includes('script')) {
          agent = 'hermes';
        } else if (text.includes('rate') || text.includes('reason') || text.includes('live') || text.includes('telemetry') || text.includes('key')) {
          agent = 'grok';
        } else if (text.includes('terminal') || text.includes('sandbox')) {
          agent = 'opencode';
        } else if (text.includes('synth') || text.includes('speed')) {
          agent = 'codex';
        }
        return { ...t, assignedAgent: agent, updatedAt: Date.now() };
      });
      saveKanbanTasks(updated);
      return NextResponse.json({ ok: true, tasks: updated });
    }

    if (body.action === 'update_column') {
      const { taskId, column } = body;
      const updated = tasks.map(t => t.id === taskId ? { ...t, column, updatedAt: Date.now() } : t);
      saveKanbanTasks(updated);
      return NextResponse.json({ ok: true, tasks: updated });
    }

    if (body.action === 'delete') {
      const { taskId } = body;
      const updated = tasks.filter(t => t.id !== taskId);
      saveKanbanTasks(updated);
      return NextResponse.json({ ok: true, tasks: updated });
    }

    // Create new task
    const { title, description, priority, assignedAgent, column } = body;
    if (!title) {
      return NextResponse.json({ ok: false, error: 'Title is required' }, { status: 400 });
    }

    const newTask: KanbanTask = {
      id: `task-${Date.now()}`,
      title,
      description: description || '',
      column: column || 'inbox',
      priority: priority || 'normal',
      assignedAgent: assignedAgent || 'unassigned',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const updated = [newTask, ...tasks];
    saveKanbanTasks(updated);
    return NextResponse.json({ ok: true, task: newTask, tasks: updated });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
