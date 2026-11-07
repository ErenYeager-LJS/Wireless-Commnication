import { useEffect, useState } from 'react';
import type { ServerMessage, Snapshot } from './types';
import { api } from './api';

export function usePlatform() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let active = true;
    let retry: number | undefined;
    let socket: WebSocket | undefined;
    api.snapshot().then((data) => active && setSnapshot(data)).catch(() => undefined);

    const connect = () => {
      const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${protocol}://${location.host}/ws`);
      socket.onopen = () => active && setConnected(true);
      socket.onmessage = (event) => {
        const message = JSON.parse(event.data) as ServerMessage;
        if ((message.type === 'snapshot' || message.type === 'state') && active) setSnapshot(message.data);
      };
      socket.onclose = () => {
        if (!active) return;
        setConnected(false);
        retry = window.setTimeout(connect, 1_500);
      };
    };
    connect();
    return () => { active = false; clearTimeout(retry); socket?.close(); };
  }, []);
  return { snapshot, connected };
}
