export interface NetworkProbe {
  timestamp: number;
  latency: number | null; // ms, null if failed
  isOnline: boolean;
  downloadSpeed: number | null; // Mbps
  connectionType: string;
  effectiveType: string;
  downlink: number;
  rtt: number;
  target: string;
  error?: string;
}

export interface DiagnosticResult {
  id: string;
  timestamp: number;
  type: 'info' | 'warning' | 'error' | 'success';
  title: string;
  description: string;
  suggestion?: string;
}

export interface MonitorStats {
  totalProbes: number;
  successfulProbes: number;
  failedProbes: number;
  packetLossRate: number;
  avgLatency: number;
  minLatency: number;
  maxLatency: number;
  avgSpeed: number;
  uptimePercent: number;
  startTime: number;
  lastOnline: number | null;
  lastOffline: number | null;
  consecutiveFailures: number;
  maxConsecutiveFailures: number;
  jitter: number;
}

export type MonitorStatus = 'idle' | 'running' | 'paused';
