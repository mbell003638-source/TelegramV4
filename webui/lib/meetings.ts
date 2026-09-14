export interface MeetingSession {
  id: string;
  provider: 'google' | 'daily' | 'pika' | 'recall';
  agentId: string;
  meetUrl: string;
  mode: 'direct' | 'roundtable';
  autoBrief: boolean;
  status: 'live' | 'ended';
  createdAt: number;
}

// In-memory global store to ensure persistence across API invocations in Next.js
declare global {
  // eslint-disable-next-line no-var
  var __meetingSessions: MeetingSession[] | undefined;
}

if (!global.__meetingSessions) {
  global.__meetingSessions = [];
}

export function getMeetingSessions(): MeetingSession[] {
  return global.__meetingSessions || [];
}

export function addMeetingSession(session: MeetingSession): MeetingSession {
  if (!global.__meetingSessions) global.__meetingSessions = [];
  // Prepend to top
  global.__meetingSessions.unshift(session);
  return session;
}

export function removeMeetingSession(id: string): boolean {
  if (!global.__meetingSessions) return false;
  const initialLen = global.__meetingSessions.length;
  global.__meetingSessions = global.__meetingSessions.filter(s => s.id !== id);
  return global.__meetingSessions.length < initialLen;
}

export function clearMeetingSessions(): void {
  global.__meetingSessions = [];
}
