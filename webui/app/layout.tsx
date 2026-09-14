import './globals.css';
import Sidebar from '@/components/Sidebar';
import JarvisAssistant from '@/components/JarvisAssistant';
import React from 'react';

export const metadata = {
  title: 'Agentic OS — Super AMOLED Mission Control',
  description: 'Dopamine-inducing local operating system for multi-agent Claude Code, Codex, Grok, and Hermes.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark bg-black">
      <body className="bg-black text-gray-100 min-h-screen flex antialiased overflow-hidden">
        <Sidebar />
        <main className="flex-1 h-screen overflow-y-auto bg-black relative flex flex-col">
          {children}
        </main>
        <JarvisAssistant />
      </body>
    </html>
  );
}
