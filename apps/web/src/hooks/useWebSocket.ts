'use client';

import { useEffect, useCallback, useRef, useState } from 'react';
import io, { Socket } from 'socket.io-client';
import { useUIStore } from '@/stores/uiStore';
import { useAuthStore } from '@/stores/authStore';

interface UseWebSocketOptions {
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (error: Error) => void;
  autoConnect?: boolean;
  reconnectDelay?: number;
}

let sharedSocket: Socket | null = null;
let sharedToken: string | null = null;
let listenersBound = false;
let refCount = 0;

export function useWebSocket(options: UseWebSocketOptions = {}) {
  const {
    onConnect,
    onDisconnect,
    onError,
    autoConnect = true,
    reconnectDelay = 3000,
  } = options;

  const { accessToken } = useAuthStore();
  const { setWsConnected } = useUIStore();
  const [, setVersion] = useState(0);
  const mountedRef = useRef(true);

  const forceRender = useCallback(() => {
    if (!mountedRef.current) return;
    setVersion((v) => v + 1);
  }, []);

  const bindListeners = useCallback((socket: Socket) => {
    if (listenersBound) return;
    listenersBound = true;
    socket.on('connect', () => {
      setWsConnected(true);
      forceRender();
      onConnect?.();
    });
    socket.on('disconnect', () => {
      setWsConnected(false);
      forceRender();
      onDisconnect?.();
    });
    socket.on('error', (error: any) => {
      onError?.(new Error(error?.message || 'WebSocket error'));
    });
  }, [forceRender, onConnect, onDisconnect, onError, setWsConnected]);

  const connect = useCallback(() => {
    if (!accessToken) return;
    if (sharedSocket?.connected && sharedToken === accessToken) return;

    if (sharedSocket && sharedToken !== accessToken) {
      sharedSocket.disconnect();
      sharedSocket = null;
      listenersBound = false;
    }

    if (!sharedSocket) {
      const baseUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';
      sharedSocket = io(`${baseUrl.replace(/\/$/, '')}/telemetry`, {
        auth: { token: accessToken },
        transports: ['websocket'],
        reconnection: true,
        reconnectionDelay: reconnectDelay,
        reconnectionDelayMax: 10000,
        reconnectionAttempts: 10,
      });
      sharedToken = accessToken;
      bindListeners(sharedSocket);
    } else if (!sharedSocket.connected) {
      sharedSocket.connect();
    }
  }, [accessToken, bindListeners, reconnectDelay]);

  const disconnect = useCallback(() => {
    refCount = Math.max(0, refCount - 1);
    if (refCount === 0 && sharedSocket) {
      sharedSocket.disconnect();
      sharedSocket = null;
      sharedToken = null;
      listenersBound = false;
      setWsConnected(false);
      forceRender();
    }
  }, [forceRender, setWsConnected]);

  const emit = useCallback((event: string, data: any) => {
    if (sharedSocket?.connected) {
      sharedSocket.emit(event, data);
    }
  }, []);

  const on = useCallback((event: string, callback: (data: any) => void) => {
    if (sharedSocket) sharedSocket.on(event, callback);
  }, []);

  const off = useCallback((event: string, callback?: (data: any) => void) => {
    if (sharedSocket) sharedSocket.off(event, callback);
  }, []);

  const subscribeVehicle = useCallback((vehicleId: string) => {
    emit('subscribe:vehicle', { vehicleId });
  }, [emit]);

  const unsubscribeVehicle = useCallback((vehicleId: string) => {
    emit('unsubscribe:vehicle', { vehicleId });
  }, [emit]);

  useEffect(() => {
    mountedRef.current = true;
    refCount += 1;
    if (autoConnect && accessToken) connect();
    return () => {
      mountedRef.current = false;
      disconnect();
    };
  }, [accessToken, autoConnect, connect, disconnect]);

  return {
    connected: sharedSocket?.connected || false,
    emit,
    on,
    off,
    connect,
    disconnect,
    subscribeVehicle,
    unsubscribeVehicle,
    socket: sharedSocket,
  };
}
