'use client';

import React, { useState, useEffect, useRef } from 'react';
import { Mic, MicOff } from 'lucide-react';

interface VoiceButtonProps {
  onTranscript: (text: string) => void;
  onListeningChange?: (listening: boolean) => void;
  className?: string;
}

export default function VoiceButton({ onTranscript, onListeningChange, className = '' }: VoiceButtonProps) {
  const [isListening, setIsListening] = useState(false);
  const [isSupported, setIsSupported] = useState(true);
  const recognitionRef = useRef<any>(null);

  useEffect(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setIsSupported(false);
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onstart = () => {
      setIsListening(true);
      onListeningChange?.(true);
    };
    recognition.onend = () => {
      setIsListening(false);
      onListeningChange?.(false);
    };
    recognition.onerror = () => {
      setIsListening(false);
      onListeningChange?.(false);
    };

    recognition.onresult = (event: any) => {
      let finalTranscript = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          finalTranscript += event.results[i][0].transcript;
        }
      }
      if (finalTranscript.trim()) {
        onTranscript(finalTranscript.trim());
      }
    };

    recognitionRef.current = recognition;
  }, [onTranscript]);

  const toggleListening = () => {
    if (!isSupported) {
      alert('Speech recognition is not supported in this browser. Please use Chrome, Edge, or Safari.');
      return;
    }

    if (isListening) {
      try { recognitionRef.current?.stop(); } catch {}
      setIsListening(false);
    } else {
      try { recognitionRef.current?.start(); } catch {}
      setIsListening(true);
    }
  };

  return (
    <button
      type="button"
      onClick={toggleListening}
      className={`relative p-2.5 rounded-xl border transition-all duration-200 flex items-center justify-center ${
        isListening
          ? 'bg-red-950/70 border-red-500 text-red-400 shadow-[0_0_20px_rgba(239,68,68,0.5)] animate-pulse'
          : 'bg-[#080c18] border-blue-900/40 text-blue-400 hover:text-sky-300 hover:border-blue-500/60 hover:shadow-[0_0_15px_rgba(59,130,246,0.3)]'
      } ${className}`}
      title={isListening ? 'Listening... click to stop' : 'Voice dictation (click to speak)'}
    >
      {isListening ? (
        <>
          <MicOff className="w-5 h-5" />
          <span className="absolute -top-1 -right-1 flex h-2.5 w-2.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500"></span>
          </span>
        </>
      ) : (
        <Mic className="w-5 h-5" />
      )}
    </button>
  );
}
