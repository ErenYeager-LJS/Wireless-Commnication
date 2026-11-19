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
    let lastMessage = Date.now();
    const invalidate = () => setSnapshot(previous => previous?.esp ? {...previous, health: 'offline', camera: {...previous.camera, frameUrl: null},
      nodes: previous.nodes.map(node => ({...node, online: false})),
      esp: {...previous.esp, receiverAvailable: false, error: '平台连接中断，正在重连',
        control: previous.esp.control ? {...previous.esp.control, wireless_online: false} : null,
        video: previous.esp.video ? {...previous.esp.video, online: false} : null,
        detection: previous.esp.detection ? {...previous.esp.detection, fresh: false, boxes: []} : null}} : previous);
    api.snapshot().then((data) => {if (active) {lastMessage = Date.now(); setSnapshot(data);}}).catch(() => undefined);

    const connect = () => {
      const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${protocol}://${location.host}/ws`);
      socket.onopen = () => active && setConnected(true);
      socket.onmessage = (event) => {
        const message = JSON.parse(event.data) as ServerMessage;
        lastMessage = Date.now();
        if ((message.type === 'snapshot' || message.type === 'state') && active) setSnapshot(message.data);
      };
      socket.onclose = () => {
        if (!active) return;
        setConnected(false);
        invalidate();
        retry = window.setTimeout(connect, 1_500);
      };
    };
    connect();
    const watchdog = setInterval(() => {if (Date.now() - lastMessage > 2_000) invalidate();}, 500);
    return () => { active = false; clearTimeout(retry); clearInterval(watchdog); socket?.close(); };
  }, []);
  return { snapshot, connected };
}
