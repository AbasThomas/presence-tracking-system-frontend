"use client";

import clsx from "classnames";
import { useEffect, useMemo, useRef, useState } from "react";
import { Client, IMessage, StompSubscription } from "@stomp/stompjs";
// @ts-ignore
import SockJS from "sockjs-client";

type MessageType =
  | "JOIN"
  | "LEAVE"
  | "PING"
  | "SYSTEM"
  | "ROOM_PRESENCE"
  | "ONLINE_USERS";

type PresenceUser = {
  userId: string;
  username: string;
  currentRoom?: string | null;
  lastSeen?: string;
  online?: boolean;
  createdAt?: string;
};

type RoomPresence = {
  roomId: string;
  userCount: number;
  users: PresenceUser[];
};

type SystemStats = {
  totalUsers?: number;
  onlineUsers?: number;
  activeRooms?: number;
  activeSessions?: number;
  timestamp?: string;
};

type WireMessage = {
  type: MessageType;
  roomId?: string;
  userId?: string;
  username?: string;
  content?: string;
  data?: unknown;
  timestamp?: string;
};

const defaultWs =
  process.env.NEXT_PUBLIC_WS_URL ?? "http://localhost:8080/ws-presence";

const randomId = () =>
  typeof crypto !== "undefined"
    ? crypto.randomUUID().slice(0, 8)
    : `user-${Math.random().toString(36).slice(2, 10)}`;

export default function Home() {
  const [wsUrl, setWsUrl] = useState(defaultWs);
  const [userId, setUserId] = useState(randomId);
  const [username, setUsername] = useState("Thomas Abas");
  const [roomId, setRoomId] = useState("mission-control");
  const [status, setStatus] = useState<"disconnected" | "connecting" | "connected">(
    "disconnected",
  );
  const [presence, setPresence] = useState<RoomPresence | null>(null);
  const [onlineUsers, setOnlineUsers] = useState<PresenceUser[]>([]);
  const [logs, setLogs] = useState<
    { content: string; roomId?: string; timestamp: string }[]
  >([]);
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastPing, setLastPing] = useState<string | null>(null);
  const [nowTs, setNowTs] = useState(() => Date.now());
  const [activeTab, setActiveTab] = useState<"room" | "global" | "logs">("room");

  const clientRef = useRef<Client | null>(null);
  const roomSubscriptionRef = useRef<StompSubscription | null>(null);

  const connectionReady = status === "connected";

  const statusCopy = useMemo(
    () =>
    ({
      disconnected: "Offline",
      connecting: "Connecting…",
      connected: "Live",
    }[status]),
    [status],
  );

  const addLog = (entry: { content: string; roomId?: string; timestamp?: string }) => {
    setLogs((prev) =>
      [
        {
          content: entry.content,
          roomId: entry.roomId,
          timestamp: entry.timestamp ?? new Date().toISOString(),
        },
        ...prev,
      ].slice(0, 30),
    );
  };

  const disconnect = () => {
    roomSubscriptionRef.current?.unsubscribe();
    roomSubscriptionRef.current = null;
    clientRef.current?.deactivate();
    clientRef.current = null;
    setStatus("disconnected");
    setPresence(null);
  };

  useEffect(() => () => disconnect(), []);
  useEffect(() => {
    const timer = setInterval(() => setNowTs(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const subscribeCoreRoutes = (client: Client) => {
    client.subscribe("/user/queue/room-presence", (message: IMessage) => {
      const payload: WireMessage = JSON.parse(message.body);
      if (payload.data) {
        setPresence(payload.data as RoomPresence);
      }
    });

    client.subscribe("/user/queue/online-users", (message: IMessage) => {
      const payload: WireMessage = JSON.parse(message.body);
      if (Array.isArray(payload.data)) {
        setOnlineUsers(payload.data as PresenceUser[]);
      }
    });

    client.subscribe("/user/queue/system-stats", (message: IMessage) => {
      const payload: WireMessage = JSON.parse(message.body);
      setStats(payload.data as SystemStats);
    });
  };

  const subscribeRoom = (client: Client, room: string) => {
    roomSubscriptionRef.current?.unsubscribe();
    roomSubscriptionRef.current = client.subscribe(
      `/topic/room/${room}`,
      (message: IMessage) => {
        const payload: WireMessage = JSON.parse(message.body);

        // Handle presence updates broadcasted to the room
        if (payload.type === "ROOM_PRESENCE" && payload.data) {
          setPresence(payload.data as RoomPresence);
        }

        // Handle system messages / logs
        if (payload.content) {
          addLog({
            content: payload.content,
            roomId: payload.roomId,
            timestamp: payload.timestamp,
          });
        }
      },
    );
  };

  const sendMessage = (destination: string, body: WireMessage) => {
    const client = clientRef.current;
    if (!client || !client.connected) {
      setError("Connect first to send messages.");
      return;
    }

    client.publish({
      destination,
      body: JSON.stringify({
        roomId,
        userId,
        username,
        ...body,
      }),
    });
  };

  const connectAndJoin = () => {
    if (status === "connecting") return;
    disconnect();
    setError(null);
    setStatus("connecting");

    const client = new Client({
      reconnectDelay: 5000,
      webSocketFactory: () => new SockJS(wsUrl),
      onStompError: (frame) => {
        setError(frame.headers["message"] ?? "Broker error");
        setStatus("disconnected");
      },
      onWebSocketError: () => {
        setError("WebSocket connection failed");
        setStatus("disconnected");
      },
      onConnect: () => {
        setStatus("connected");
        setError(null);
        subscribeCoreRoutes(client);
        subscribeRoom(client, roomId);
        sendMessage("/app/join", { type: "JOIN" });
        requestPresence();
        requestOnline();
        requestStats();
        addLog({
          content: `Joined room ${roomId}`,
          roomId,
        });
      },
    });

    client.activate();
    clientRef.current = client;
  };

  const requestPresence = () =>
    sendMessage("/app/room/presence", { type: "ROOM_PRESENCE" });
  const requestOnline = () => sendMessage("/app/users/online", { type: "ONLINE_USERS" });
  const requestStats = () => sendMessage("/app/system/stats", { type: "SYSTEM" });

  const sendPing = () => {
    sendMessage("/app/ping", { type: "PING" });
    const ts = new Date().toISOString();
    setLastPing(ts);
  };

  const leaveRoom = () => {
    sendMessage("/app/leave", { type: "LEAVE" });
    setPresence(null);
    addLog({ content: `Left room ${roomId}` });
  };

  const switchRoom = () => {
    if (!connectionReady) {
      setError("Connect first, then switch rooms.");
      return;
    }
    subscribeRoom(clientRef.current!, roomId);
    sendMessage("/app/join", { type: "JOIN" });
    requestPresence();
    addLog({ content: `Moved to ${roomId}` });
  };

  const formatRelative = (value?: string) => {
    if (!value) return "—";
    const date = new Date(value);
    const diff = nowTs - date.getTime();
    const mins = Math.round(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return date.toLocaleDateString();
  };

  const avatar = (user: PresenceUser) => {
    const hue = Math.abs(hashCode(user.userId ?? user.username ?? "u")) % 360;
    return (
      <div
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl text-xs font-bold text-white shadow-lg shadow-black/20"
        style={{
          background: `linear-gradient(135deg, hsl(${hue} 70% 60%), hsl(${(hue + 40) % 360} 70% 45%))`,
        }}
      >
        {user.username?.slice(0, 2)?.toUpperCase() ?? "U"}
      </div>
    );
  };

  return (
    <div className="flex h-screen w-full bg-[#02040a] text-[#f8fafc] overflow-hidden selection:bg-emerald-500/20 selection:text-emerald-400 font-sans relative">
      {/* Mesh Gradient Background */}
      <div className="mesh-container">
        <div className="mesh-gradient" />
      </div>

      {!connectionReady ? (
        /* Gateway Experience */
        <div className="flex-1 flex items-center justify-center z-10 p-6 animate-in fade-in zoom-in duration-1000">
          <div className="w-full max-w-lg relative">
            {/* Outer Glow / Aura */}
            <div className="absolute -inset-24 bg-emerald-500/10 blur-[100px] rounded-full animate-slow-pulse" />

            <div className="hub-glass rounded-[3rem] p-12 relative overflow-hidden group border-white/10">
              {/* Scanline Effect */}
              <div className="absolute inset-0 bg-[linear-gradient(to_bottom,transparent_50%,rgba(16,185,129,0.02)_50%)] bg-[length:100%_4px] pointer-events-none" />

              <div className="relative z-10">
                <div className="flex flex-col items-center mb-12 text-center">
                  <div className="relative mb-8 group-hover:scale-110 transition-transform duration-700">
                    <div className="absolute inset-0 bg-emerald-500 blur-2xl opacity-20 group-hover:opacity-40 transition-opacity" />
                    <div className="h-20 w-20 rounded-[2rem] bg-emerald-500 flex items-center justify-center shadow-2xl shadow-emerald-500/50 relative z-10 overflow-hidden">
                      <div className="absolute inset-0 bg-gradient-to-tr from-black/20 to-transparent" />
                      <svg className="w-10 h-10 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </div>
                  </div>

                  <h1 className="text-5xl font-display font-bold tracking-tighter mb-3 bg-gradient-to-b from-white to-white/40 bg-clip-text text-transparent">
                    CORE_GATEWAY
                  </h1>
                  <div className="flex items-center gap-2">
                    <div className="h-1 w-1 rounded-full bg-emerald-500 animate-pulse" />
                    <p className="text-[10px] font-mono font-bold text-white/30 uppercase tracking-[0.4em]">Awaiting Uplink Synchronization</p>
                  </div>
                </div>

                <div className="space-y-8">
                  <div className="grid grid-cols-1 gap-6">
                    <div className="space-y-3">
                      <div className="flex items-center justify-between px-1">
                        <label className="text-[10px] font-bold text-white/40 uppercase tracking-[0.2em]">User_Identity</label>
                        <span className="text-[9px] font-mono text-emerald-500/40 font-bold">ALPHA_v4</span>
                      </div>
                      <div className="relative group/input">
                        <input
                          className="input-field pl-12 h-14 bg-white/[0.02] border-white/5 hover:border-emerald-500/30 focus:border-emerald-500/50 transition-all duration-500 text-lg font-display tracking-tight"
                          value={username}
                          onChange={(e) => setUsername(e.target.value)}
                          placeholder="Thomas Abas"
                        />
                        <div className="absolute left-4 top-1/2 -translate-y-1/2 text-white/20 group-focus-within/input:text-emerald-500/50 transition-colors">
                          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                            <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 7a4 4 0 100-8 4 4 0 000 8z" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </div>
                      </div>
                    </div>

                    <div className="space-y-3">
                      <div className="flex items-center justify-between px-1">
                        <label className="text-[10px] font-bold text-white/40 uppercase tracking-[0.2em] ml-1">Sector_Coordinate</label>
                        <span className="text-[9px] font-mono text-emerald-500/40 font-bold">NODE_LOCK</span>
                      </div>
                      <div className="relative group/input">
                        <input
                          className="input-field pl-12 h-14 bg-white/[0.02] border-white/5 hover:border-emerald-500/30 focus:border-emerald-500/50 transition-all duration-500 text-lg font-display tracking-tight"
                          value={roomId}
                          onChange={(e) => setRoomId(e.target.value)}
                          placeholder="mission-control"
                        />
                        <div className="absolute left-4 top-1/2 -translate-y-1/2 text-white/20 group-focus-within/input:text-emerald-500/50 transition-colors">
                          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                            <path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </div>
                      </div>
                    </div>
                  </div>

                  {error && (
                    <div className="p-4 rounded-2xl bg-red-500/5 border border-red-500/20 text-red-400 text-[10px] font-mono font-bold text-center animate-in shake duration-500">
                      <span className="opacity-50">CRITICAL_ERROR:</span> {error.toUpperCase()}
                    </div>
                  )}

                  <button
                    onClick={connectAndJoin}
                    disabled={status === "connecting"}
                    className="button-primary w-full h-16 text-lg font-display font-bold uppercase tracking-widest relative overflow-hidden group/btn"
                  >
                    <div className="absolute inset-0 bg-gradient-to-r from-emerald-600 to-emerald-400 opacity-0 group-hover/btn:opacity-100 transition-opacity duration-500" />
                    <span className="relative z-10 flex items-center justify-center gap-3">
                      {status === "connecting" ? (
                        <>
                          <div className="h-5 w-5 border-2 border-black/20 border-t-black rounded-full animate-spin" />
                          Synchronizing...
                        </>
                      ) : (
                        <>ESTABLISH_UPLINK</>
                      )}
                    </span>
                  </button>
                </div>

                <div className="mt-12 flex justify-between items-center opacity-40 hover:opacity-100 transition-opacity">
                  <div className="flex gap-4">
                    <div className="h-[2px] w-8 bg-emerald-500 rounded-full" />
                    <div className="h-[2px] w-4 bg-white/20 rounded-full" />
                    <div className="h-[2px] w-4 bg-white/20 rounded-full" />
                  </div>
                  <span className="text-[9px] font-mono font-bold uppercase tracking-widest text-white/30">Protocol_v1.0.8 // THOMAS_ABAS</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : (
        /* Command Hub 2.0 - Tactical HUD */
        <div className="flex-1 flex flex-col z-10 p-4 gap-4 animate-in fade-in slide-in-from-bottom-10 duration-1000 relative">

          {/* Top HUD Bar */}
          <header className="h-20 tactical-glass rounded-3xl flex items-center justify-between px-8 border-white/10 relative overflow-hidden group">
            <div className="absolute inset-0 grid-overlay opacity-20 pointer-events-none" />

            <div className="relative z-10">
              <div className="flex items-center gap-4">
                <div className="h-10 w-10 rounded-xl bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center shadow-lg shadow-emerald-500/10">
                  <div className="h-4 w-4 bg-emerald-500 rounded-sm animate-pulse" />
                </div>
                <div>
                  <h2 className="text-xl font-display font-bold tracking-tight">
                    <span className="text-white/20 font-light">HUB:</span> {activeTab === 'room' ? `SECTOR_${roomId.toUpperCase()}` : activeTab === 'global' ? 'NETWORK_GRID' : 'SIGNAL_STREAM'}
                  </h2>
                  <div className="flex items-center gap-3 mt-0.5">
                    <div className="h-1 w-1 rounded-full bg-emerald-500 animate-pulse" />
                    <span className="text-[9px] font-mono text-white/40 uppercase tracking-widest">{username} // UPLINK_STABLE</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="relative z-10 flex gap-4">
              <div className="flex flex-col items-end justify-center px-4 border-r border-white/5">
                <span className="text-[9px] font-bold text-white/20 uppercase tracking-widest">Latency</span>
                <span className="text-xs font-mono font-bold text-emerald-500/80">12MS_SYNC</span>
              </div>
              <button
                onClick={sendPing}
                className="h-10 px-6 rounded-xl bg-white/[0.03] hover:bg-emerald-500/10 border border-white/5 hover:border-emerald-500/30 text-[10px] font-bold uppercase tracking-widest transition-all active:scale-95 group/ping"
              >
                <span className="group-hover:text-emerald-400">Transmit_Ping</span>
              </button>
            </div>
          </header>

          <div className="flex-1 flex gap-4 min-h-0">
            {/* Left HUD Panel - System Nav */}
            <aside className="w-20 tactical-glass rounded-[2rem] flex flex-col items-center py-8 gap-6 border-white/10 relative overflow-hidden">
              <div className="absolute inset-0 grid-overlay opacity-10 pointer-events-none" />

              <button
                onClick={() => setActiveTab("room")}
                className={clsx(
                  "h-12 w-12 rounded-2xl flex items-center justify-center transition-all duration-500 relative group/nav",
                  activeTab === "room" ? "bg-emerald-500 text-black shadow-lg shadow-emerald-500/40" : "text-white/20 hover:text-white/60 hover:bg-white/5"
                )}
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {activeTab === "room" && <div className="absolute -right-1 top-1/2 -translate-y-1/2 w-1 h-4 bg-emerald-500 rounded-full blur-[2px]" />}
              </button>

              <button
                onClick={() => setActiveTab("global")}
                className={clsx(
                  "h-12 w-12 rounded-2xl flex items-center justify-center transition-all duration-500 relative group/nav",
                  activeTab === "global" ? "bg-emerald-500 text-black shadow-lg shadow-emerald-500/40" : "text-white/20 hover:text-white/60 hover:bg-white/5"
                )}
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {activeTab === "global" && <div className="absolute -right-1 top-1/2 -translate-y-1/2 w-1 h-4 bg-emerald-500 rounded-full blur-[2px]" />}
              </button>

              <button
                onClick={() => setActiveTab("logs")}
                className={clsx(
                  "h-12 w-12 rounded-2xl flex items-center justify-center transition-all duration-500 relative group/nav",
                  activeTab === "logs" ? "bg-emerald-500 text-black shadow-lg shadow-emerald-500/40" : "text-white/20 hover:text-white/60 hover:bg-white/5"
                )}
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M13 10V3L4 14H11V21L20 10H13Z" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {activeTab === "logs" && <div className="absolute -right-1 top-1/2 -translate-y-1/2 w-1 h-4 bg-emerald-500 rounded-full blur-[2px]" />}
              </button>

              <div className="mt-auto pb-4 flex flex-col items-center gap-6">
                <div className="flex flex-col items-center gap-1 group/stat">
                  <div className="text-[10px] font-mono font-bold text-white/20 group-hover:text-emerald-500/50 transition-colors uppercase vertical-text">Active</div>
                  <div className="text-xs font-mono font-bold text-white/40">{presence?.userCount ?? 0}</div>
                </div>
                <button
                  onClick={disconnect}
                  className="h-10 w-10 rounded-xl bg-red-500/10 hover:bg-red-500 text-red-500 hover:text-black border border-red-500/20 transition-all flex items-center justify-center"
                >
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                    <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </div>
            </aside>

            {/* Main Content Viewport */}
            <main className="flex-1 flex flex-col gap-4 min-w-0">
              <div className="flex-1 tactical-glass rounded-[2rem] overflow-hidden flex flex-col border-white/10 relative group/viewport">
                <div className="absolute inset-0 grid-overlay opacity-[0.03] pointer-events-none" />

                <div className="flex-1 overflow-y-auto p-8 custom-scrollbar relative z-10">
                  {activeTab === "room" && (
                    <div className="animate-in fade-in slide-in-from-right-8 duration-700">
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                        {(!presence?.users || presence.users.length === 0) && (
                          <div className="col-span-full h-96 border border-emerald-500/10 rounded-[2.5rem] flex flex-col items-center justify-center bg-emerald-500/[0.01] relative overflow-hidden group/empty">
                            <div className="absolute inset-0 grid-overlay opacity-10" />
                            <div className="h-2 w-32 bg-emerald-500/5 rounded-full mb-8 relative overflow-hidden">
                              <div className="absolute inset-0 bg-emerald-500/30 animate-ping-scan" />
                            </div>
                            <p className="text-sm font-mono font-bold text-emerald-500/40 uppercase tracking-[0.4em]">Grid_Empty // Scanning_Nodes</p>
                          </div>
                        )}
                        {presence?.users.map((user) => (
                          <div key={user.userId} className="node-card rounded-[2rem] p-6 flex flex-col gap-5 group/node relative">
                            <div className="flex items-start justify-between">
                              <div className="relative group/avatar">
                                <div className="absolute -inset-1 bg-emerald-500/20 blur-lg rounded-full opacity-0 group-hover/avatar:opacity-100 transition-opacity" />
                                {avatar(user)}
                                <div className="absolute -bottom-1 -right-1 h-4 w-4 rounded-full border-[3px] border-[#0d111a] bg-emerald-500 shadow-[0_0_10px_#10b981]" />
                              </div>
                              <div className="flex flex-col items-end">
                                <span className="text-[10px] font-mono font-bold text-emerald-500/60 uppercase tracking-widest leading-none mb-1">Status_OK</span>
                                <div className="flex gap-0.5">
                                  {[1, 2, 3, 4].map(i => <div key={i} className="h-0.5 w-3 bg-emerald-500/20 rounded-full" />)}
                                </div>
                              </div>
                            </div>

                            <div className="min-w-0">
                              <h4 className="font-display font-bold text-xl truncate text-white/90 group-hover/node:text-white transition-colors">
                                {user.username}
                              </h4>
                              <p className="text-[10px] font-mono font-bold text-white/20 uppercase tracking-widest mt-1">NODE_ADDR: {user.userId.slice(0, 12)}</p>
                            </div>

                            <div className="pt-4 border-t border-white/5 flex items-center justify-between">
                              <span className="text-[9px] font-bold text-white/30 uppercase tracking-tighter">Last_Pulse: {formatRelative(user.lastSeen)}</span>
                              <div className="h-6 w-12 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
                                <span className="text-[8px] font-mono font-bold text-emerald-500">2.4kb/s</span>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {activeTab === "global" && (
                    <div className="animate-in fade-in slide-in-from-right-8 duration-700">
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                        {onlineUsers.map((user) => (
                          <div key={`global-${user.userId}`} className="node-card rounded-[2rem] p-6 flex flex-col items-center text-center group/node">
                            <div className="mb-4 relative">
                              {avatar(user)}
                              <div className="absolute inset-[-6px] rounded-[1.5rem] border border-emerald-500/10 opacity-0 group-hover/node:opacity-100 group-hover/node:scale-110 transition-all duration-500" />
                            </div>
                            <h4 className="font-display font-bold text-sm truncate w-full text-white/80">{user.username}</h4>
                            <p className="text-[9px] font-mono text-emerald-500/60 font-bold uppercase tracking-widest mt-1 mb-4">@{user.currentRoom ?? 'ORBIT'}</p>
                            <div className="w-full h-1 bg-white/5 rounded-full relative overflow-hidden">
                              <div className="absolute inset-0 bg-emerald-500/20 group-hover:bg-emerald-500/40 transition-colors" style={{ width: '65%' }} />
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {activeTab === "logs" && (
                    <div className="animate-in fade-in slide-in-from-right-8 duration-700 max-w-5xl mx-auto">
                      <div className="space-y-4">
                        {logs.map((log, idx) => (
                          <div key={idx} className="terminal-line group relative py-2">
                            <div className="flex items-center gap-3 mb-1">
                              <span className="text-[9px] font-mono font-bold text-emerald-500/40 uppercase tracking-widest">{formatRelative(log.timestamp)}</span>
                              {log.roomId && <span className="px-1.5 py-0.5 rounded bg-emerald-500/5 border border-emerald-500/10 text-[8px] font-mono font-bold text-emerald-500/60 uppercase">NODE_{log.roomId.toUpperCase()}</span>}
                            </div>
                            <p className="text-sm text-white/50 group-hover:text-white transition-all duration-300 leading-relaxed font-mono">
                              <span className="text-emerald-500/30 mr-2">{">"}</span>
                              {log.content}
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* Bottom Context Bar */}
                <footer className="h-12 border-t border-white/5 px-8 flex items-center justify-between bg-black/40 relative z-20">
                  <div className="flex gap-8">
                    <div className="flex items-center gap-2">
                      <div className="h-1 w-3 bg-emerald-500/30 rounded-full" />
                      <span className="text-[9px] font-mono font-bold text-white/20 uppercase">Network_Grid: NORMAL</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="h-1 w-3 bg-emerald-500/30 rounded-full" />
                      <span className="text-[9px] font-mono font-bold text-white/20 uppercase">Global_Nodes: {stats?.onlineUsers ?? 0}</span>
                    </div>
                  </div>
                  <div className="text-[9px] font-mono font-bold text-white/10 uppercase tracking-[0.3em]">SECURE_UPLINK_v1.0.8 // [#{Math.random().toString(36).slice(2, 8).toUpperCase()}]</div>
                </footer>
              </div>
            </main>
          </div>
        </div>
      )}

      <style jsx global>{`
        @keyframes shake {
          10%, 90% { transform: translate3d(-1px, 0, 0); }
          20%, 80% { transform: translate3d(2px, 0, 0); }
          30%, 50%, 70% { transform: translate3d(-4px, 0, 0); }
          40%, 60% { transform: translate3d(4px, 0, 0); }
        }
        .animate-shake {
          animation: shake 0.82s cubic-bezier(.36,.07,.19,.97) both;
        }
      `}</style>
    </div>
  );
}

function hashCode(input: string) {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}
