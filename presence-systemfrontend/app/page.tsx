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
  const [username, setUsername] = useState("Nova Collins");
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
        <div className="flex-1 flex items-center justify-center z-10 p-6 animate-in fade-in zoom-in duration-700">
          <div className="w-full max-w-md hub-glass rounded-[2.5rem] p-10 relative overflow-hidden group">
            <div className="absolute inset-0 bg-gradient-to-br from-emerald-500/[0.03] to-transparent pointer-events-none" />

            <div className="flex flex-col items-center mb-10 text-center">
              <div className="h-16 w-16 rounded-2xl bg-emerald-500 mb-6 flex items-center justify-center shadow-2xl shadow-emerald-500/40 rotate-[10deg] group-hover:rotate-[0deg] transition-transform duration-700">
                <div className="h-8 w-8 bg-white/30 rounded-lg" />
              </div>
              <h1 className="text-4xl font-display font-bold tracking-tight mb-2">Command Center</h1>
              <p className="text-sm text-white/40 font-medium">Configure identity to establish uplink</p>
            </div>

            <div className="space-y-6">
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-white/30 uppercase tracking-[0.2em] ml-1">Identity Tag</label>
                <div className="relative">
                  <input
                    className="input-field pl-11"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="e.g. Nova Collins"
                  />
                  <div className="absolute left-4 top-1/2 -translate-y-1/2 text-white/20">
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M12 7a4 4 0 100-8 4 4 0 000 8z" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-[10px] font-bold text-white/30 uppercase tracking-[0.2em] ml-1">Sector Destination</label>
                <div className="relative">
                  <input
                    className="input-field pl-11"
                    value={roomId}
                    onChange={(e) => setRoomId(e.target.value)}
                    placeholder="e.g. mission-control"
                  />
                  <div className="absolute left-4 top-1/2 -translate-y-1/2 text-white/20">
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <path d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </div>
                </div>
              </div>

              {error && (
                <div className="p-4 rounded-2xl bg-red-500/5 border border-red-500/10 text-red-400 text-[11px] font-bold text-center animate-in shake duration-500">
                  SIGNAL_INTERRUPTED: {error.toUpperCase()}
                </div>
              )}

              <button
                onClick={connectAndJoin}
                disabled={status === "connecting"}
                className="button-primary w-full mt-4"
              >
                {status === "connecting" ? (
                  <>
                    <div className="h-4 w-4 border-2 border-black/20 border-t-black rounded-full animate-spin" />
                    Establishing Uplink...
                  </>
                ) : (
                  <>Establish Uplink</>
                )}
              </button>
            </div>

            <div className="mt-8 flex justify-center gap-6">
              <div className="flex flex-col items-center opacity-20 hover:opacity-100 transition-opacity cursor-default">
                <span className="text-[9px] font-bold uppercase tracking-widest mb-1 text-emerald-400">STOMP_ACTIVE</span>
                <div className="h-[2px] w-4 bg-emerald-500 rounded-full" />
              </div>
              <div className="flex flex-col items-center opacity-20 hover:opacity-100 transition-opacity cursor-default">
                <span className="text-[9px] font-bold uppercase tracking-widest mb-1">SOCKJS_READY</span>
                <div className="h-[2px] w-4 bg-white rounded-full" />
              </div>
            </div>
          </div>
        </div>
      ) : (
        /* Command Hub Dashboard */
        <div className="flex-1 flex z-10 p-6 gap-6 animate-in fade-in slide-in-from-bottom-10 duration-1000">
          {/* Sidebar Navigation */}
          <aside className="w-72 hub-glass rounded-[2rem] flex flex-col overflow-hidden">
            <div className="p-8">
              <div className="flex items-center gap-3 mb-2">
                <div className="h-8 w-8 rounded-xl bg-emerald-500 flex items-center justify-center shadow-lg shadow-emerald-500/20">
                  <div className="h-4 w-4 bg-white/30 rounded-md" />
                </div>
                <h1 className="text-xl font-display font-bold tracking-tight">Hub v1.2</h1>
              </div>
              <div className="h-[1px] w-full bg-white/5" />
            </div>

            <nav className="flex-1 px-4 space-y-1.5 overflow-y-auto custom-scrollbar">
              <button
                onClick={() => setActiveTab("room")}
                className={clsx("sidebar-link w-full", activeTab === "room" && "sidebar-link-active")}
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Room Operations
              </button>
              <button
                onClick={() => setActiveTab("global")}
                className={clsx("sidebar-link w-full", activeTab === "global" && "sidebar-link-active")}
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Global Grid
              </button>
              <button
                onClick={() => setActiveTab("logs")}
                className={clsx("sidebar-link w-full", activeTab === "logs" && "sidebar-link-active")}
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M13 10V3L4 14H11V21L20 10H13Z" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Signal Stream
              </button>

              <div className="pt-10 px-4">
                <p className="text-[10px] font-bold uppercase tracking-widest text-white/20 mb-6">ACTIVE MONITORING</p>
                <div className="space-y-6">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-medium text-white/40">Inhabitants</span>
                    <span className="text-sm font-display font-bold text-white/80">{presence?.userCount ?? 0}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-medium text-white/40">Active Nodes</span>
                    <span className="text-sm font-display font-bold text-white/80">{stats?.activeRooms ?? 0}</span>
                  </div>
                  <div className="w-full h-1 bg-white/5 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-emerald-500 shadow-[0_0_10px_#10b981] transition-all duration-1000"
                      style={{ width: `${Math.min((stats?.onlineUsers ?? 0) * 10, 100)}%` }}
                    />
                  </div>
                </div>
              </div>
            </nav>

            <div className="p-6">
              <div className="bg-white/[0.03] rounded-2xl p-4 border border-white/5">
                <div className="flex items-center gap-3 mb-4">
                  <div className="h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_10px_#10b981] animate-slow-pulse" />
                  <span className="text-xs font-bold text-emerald-400/80 tracking-tight">System Nominal</span>
                </div>
                <button
                  onClick={disconnect}
                  className="w-full py-2 text-[10px] font-bold text-white/20 hover:text-red-400 transition-colors uppercase tracking-[0.2em] border border-white/5 hover:border-red-400/20 rounded-lg"
                >
                  Terminate Link
                </button>
              </div>
            </div>
          </aside>

          {/* Main Monitor Area */}
          <div className="flex-1 flex flex-col gap-6">
            <header className="h-24 hub-glass rounded-[2rem] flex items-center justify-between px-10">
              <div>
                <h2 className="text-2xl font-display font-bold tracking-tight">
                  <span className="text-white/20 font-light">CMD: </span>
                  {activeTab === 'room' ? `SECTOR_${roomId.toUpperCase()}` : activeTab === 'global' ? 'GLOBAL_NETWORK' : 'SIGNAL_HISTORY'}
                </h2>
                <div className="flex items-center gap-3 mt-1">
                  <span className="glow-pill">Live Update</span>
                  <span className="text-[10px] font-mono text-white/20 uppercase tracking-widest">{username} // 08.02.26</span>
                </div>
              </div>
              <div className="flex gap-4">
                <button onClick={sendPing} className="h-10 px-6 rounded-xl bg-white/[0.03] hover:bg-white/[0.07] border border-white/5 text-[11px] font-bold uppercase tracking-widest transition-all active:scale-95">Send Ping</button>
                <div className="h-10 px-6 rounded-xl bg-white/[0.03] border border-white/5 flex items-center">
                  <span className="text-[10px] font-mono font-bold text-emerald-500/80">LATENCY: 12ms</span>
                </div>
              </div>
            </header>

            <div className="flex-1 hub-glass rounded-[2rem] overflow-hidden flex flex-col">
              <div className="flex-1 overflow-y-auto p-10 custom-scrollbar">
                {activeTab === "room" && (
                  <div className="animate-in fade-in slide-in-from-bottom-8 duration-700">
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                      {(!presence?.users || presence.users.length === 0) && (
                        <div className="col-span-full border border-dashed border-white/5 rounded-[2rem] p-32 text-center">
                          <p className="text-sm font-display font-medium text-white/10 uppercase tracking-[0.4em]">Grid Empty / Scanning for Signals</p>
                        </div>
                      )}
                      {presence?.users.map((user) => (
                        <div key={user.userId} className="card-glass rounded-3xl p-6 flex items-start gap-4 h-40">
                          <div className="relative">
                            {avatar(user)}
                            <div className="absolute -bottom-1 -right-1 h-3.5 w-3.5 rounded-full border-2 border-[#0d0f14] bg-emerald-500" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <h4 className="font-display font-bold text-lg truncate mb-1">{user.username}</h4>
                            <p className="text-[9px] font-mono font-bold text-white/20 uppercase tracking-widest mb-4">NODE_ID: {user.userId.slice(0, 8)}</p>
                            <div className="flex items-center justify-between">
                              <span className="text-[10px] font-bold text-white/40 uppercase">{formatRelative(user.lastSeen)}</span>
                              <div className="flex gap-1">
                                {[1, 2, 3].map(i => <div key={i} className="h-1 w-2 bg-emerald-500/20 rounded-full" />)}
                              </div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {activeTab === "global" && (
                  <div className="animate-in fade-in slide-in-from-bottom-8 duration-700">
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                      {onlineUsers.map((user) => (
                        <div key={`global-${user.userId}`} className="card-glass rounded-3xl p-6 flex flex-col items-center text-center">
                          <div className="mb-4 relative">
                            {avatar(user)}
                            <div className="absolute inset-[-4px] rounded-2xl border border-emerald-500/10 animate-pulse" />
                          </div>
                          <h4 className="font-display font-bold text-sm truncate w-full mb-1">{user.username}</h4>
                          <p className="text-[9px] font-mono text-emerald-400 font-bold uppercase tracking-widest mb-4">@{user.currentRoom ?? 'ORBIT'}</p>
                          <div className="w-full h-1 bg-white/5 rounded-full" />
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {activeTab === "logs" && (
                  <div className="max-w-4xl animate-in fade-in slide-in-from-bottom-8 duration-700">
                    <div className="space-y-6">
                      {logs.map((log, idx) => (
                        <div key={idx} className="terminal-line group">
                          <div className="flex items-center gap-3 mb-1">
                            <span className="text-[9px] font-mono font-bold text-white/10 uppercase tracking-widest">{formatRelative(log.timestamp)}</span>
                            {log.roomId && <span className="text-[9px] font-mono font-bold text-emerald-500/40 uppercase tracking-widest">[{log.roomId}]</span>}
                          </div>
                          <p className="text-sm text-white/60 group-hover:text-white transition-colors duration-300">
                            {log.content}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <footer className="h-16 border-t border-white/5 px-10 flex items-center justify-between bg-black/20">
                <div className="flex gap-10">
                  <div className="flex items-center gap-3">
                    <div className="h-1 w-1 rounded-full bg-white/40" />
                    <span className="text-[9px] font-mono font-bold text-white/20 uppercase tracking-[0.2em]">Active Sessions: {stats?.activeSessions ?? 0}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="h-1 w-1 rounded-full bg-white/40" />
                    <span className="text-[9px] font-mono font-bold text-white/20 uppercase tracking-[0.2em]">Traffic Volume: {stats?.totalUsers ?? 0}</span>
                  </div>
                </div>
                <div className="text-[9px] font-mono font-bold text-emerald-500/30 uppercase tracking-[0.2em]">Protocol: STOMP_WS_v1.0</div>
              </footer>
            </div>
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
