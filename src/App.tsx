import { useState, useEffect, useRef, useCallback } from 'react';
import {
  LineChart, Line, AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, BarChart, Bar, ReferenceLine,
} from 'recharts';
import { NetworkProbe, DiagnosticResult, MonitorStats, MonitorStatus } from './types';
import { runFullProbe, runDiagnostic, analyzeProbes } from './networkUtils';

const STORAGE_KEY = 'netdiag_probes';
const MAX_PROBES = 500;

function loadProbes(): NetworkProbe[] {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    return data ? JSON.parse(data) : [];
  } catch {
    return [];
  }
}

function saveProbes(probes: NetworkProbe[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(probes.slice(-MAX_PROBES)));
  } catch { /* ignore */ }
}

function computeStats(probes: NetworkProbe[]): MonitorStats {
  if (probes.length === 0) {
    return {
      totalProbes: 0, successfulProbes: 0, failedProbes: 0,
      packetLossRate: 0, avgLatency: 0, minLatency: 0, maxLatency: 0,
      avgSpeed: 0, uptimePercent: 100, startTime: Date.now(),
      lastOnline: null, lastOffline: null,
      consecutiveFailures: 0, maxConsecutiveFailures: 0, jitter: 0,
    };
  }

  const successProbes = probes.filter(p => p.isOnline);
  const failedProbes = probes.filter(p => !p.isOnline);
  const latencies = successProbes.map(p => p.latency).filter((l): l is number => l !== null);
  const speeds = successProbes.map(p => p.downloadSpeed).filter((s): s is number => s !== null);

  let maxConsecutive = 0;
  let currentConsecutive = 0;
  for (const probe of probes) {
    if (!probe.isOnline) {
      currentConsecutive++;
      maxConsecutive = Math.max(maxConsecutive, currentConsecutive);
    } else {
      currentConsecutive = 0;
    }
  }

  const avgLatency = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
  const minLatency = latencies.length > 0 ? Math.min(...latencies) : 0;
  const maxLatency = latencies.length > 0 ? Math.max(...latencies) : 0;
  const jitter = maxLatency - minLatency;

  return {
    totalProbes: probes.length,
    successfulProbes: successProbes.length,
    failedProbes: failedProbes.length,
    packetLossRate: probes.length > 0 ? (failedProbes.length / probes.length) * 100 : 0,
    avgLatency: Math.round(avgLatency * 10) / 10,
    minLatency: Math.round(minLatency * 10) / 10,
    maxLatency: Math.round(maxLatency * 10) / 10,
    avgSpeed: speeds.length > 0 ? Math.round((speeds.reduce((a, b) => a + b, 0) / speeds.length) * 100) / 100 : 0,
    uptimePercent: probes.length > 0 ? Math.round((successProbes.length / probes.length) * 10000) / 100 : 100,
    startTime: probes[0].timestamp,
    lastOnline: successProbes.length > 0 ? successProbes[successProbes.length - 1].timestamp : null,
    lastOffline: failedProbes.length > 0 ? failedProbes[failedProbes.length - 1].timestamp : null,
    consecutiveFailures: currentConsecutive,
    maxConsecutiveFailures: maxConsecutive,
    jitter: Math.round(jitter * 10) / 10,
  };
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}小时${minutes % 60}分钟`;
  if (minutes > 0) return `${minutes}分钟${seconds % 60}秒`;
  return `${seconds}秒`;
}

// ============ Components ============

function StatusBadge({ online }: { online: boolean }) {
  return (
    <div className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium ${online ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
      <span className={`w-3 h-3 rounded-full ${online ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`} />
      {online ? '在线' : '离线'}
    </div>
  );
}

function StatCard({ title, value, unit, icon, color }: { title: string; value: string | number; unit?: string; icon: string; color: string }) {
  return (
    <div className={`bg-white rounded-xl p-4 shadow-sm border border-gray-100 hover:shadow-md transition-shadow`}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-gray-500 text-sm">{title}</span>
        <span className={`text-xl ${color}`}>{icon}</span>
      </div>
      <div className="flex items-baseline gap-1">
        <span className="text-2xl font-bold text-gray-800">{value}</span>
        {unit && <span className="text-sm text-gray-500">{unit}</span>}
      </div>
    </div>
  );
}

function DiagnosticPanel({ diagnostics }: { diagnostics: DiagnosticResult[] }) {
  const typeStyles = {
    success: 'border-green-200 bg-green-50',
    info: 'border-blue-200 bg-blue-50',
    warning: 'border-yellow-200 bg-yellow-50',
    error: 'border-red-200 bg-red-50',
  };
  const typeIcons = {
    success: '✅',
    info: 'ℹ️',
    warning: '⚠️',
    error: '❌',
  };

  return (
    <div className="space-y-3">
      {diagnostics.map((d) => (
        <div key={d.id} className={`rounded-lg p-4 border ${typeStyles[d.type]}`}>
          <div className="flex items-start gap-2">
            <span className="text-lg">{typeIcons[d.type]}</span>
            <div className="flex-1">
              <h4 className="font-medium text-gray-800">{d.title}</h4>
              <p className="text-sm text-gray-600 mt-1">{d.description}</p>
              {d.suggestion && (
                <p className="text-sm text-gray-700 mt-2 p-2 bg-white/60 rounded border-l-2 border-orange-300">
                  💡 建议: {d.suggestion}
                </p>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function EventLog({ probes }: { probes: NetworkProbe[] }) {
  const events = probes
    .filter((p, i) => {
      if (i === 0) return true;
      return p.isOnline !== probes[i - 1].isOnline;
    })
    .slice(-20)
    .reverse();

  return (
    <div className="space-y-2 max-h-64 overflow-y-auto">
      {events.length === 0 && (
        <p className="text-gray-400 text-center py-4">暂无状态变化记录</p>
      )}
      {events.map((p, i) => (
        <div key={i} className={`flex items-center gap-3 text-sm p-2 rounded ${p.isOnline ? 'bg-green-50' : 'bg-red-50'}`}>
          <span className={`w-2 h-2 rounded-full ${p.isOnline ? 'bg-green-500' : 'bg-red-500'}`} />
          <span className="text-gray-500 font-mono">{formatTime(p.timestamp)}</span>
          <span className={p.isOnline ? 'text-green-700' : 'text-red-700'}>
            {p.isOnline ? '恢复连接' : '连接断开'}
          </span>
          {p.latency && <span className="text-gray-400 ml-auto">{p.latency.toFixed(0)}ms</span>}
        </div>
      ))}
    </div>
  );
}

// ============ Main App ============

export default function App() {
  const [probes, setProbes] = useState<NetworkProbe[]>(loadProbes);
  const [status, setStatus] = useState<MonitorStatus>('idle');
  const [interval, setIntervalValue] = useState(10); // seconds
  const [diagnostics, setDiagnostics] = useState<DiagnosticResult[]>([]);
  const [isRunningDiag, setIsRunningDiag] = useState(false);
  const [activeTab, setActiveTab] = useState<'chart' | 'diagnostic' | 'events'>('chart');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isRunningRef = useRef(false);

  const runProbe = useCallback(async () => {
    if (!isRunningRef.current) return;
    const probe = await runFullProbe();
    setProbes(prev => {
      const next = [...prev, probe].slice(-MAX_PROBES);
      saveProbes(next);
      return next;
    });
  }, []);

  const startMonitoring = useCallback(() => {
    isRunningRef.current = true;
    setStatus('running');
    
    const tick = async () => {
      if (!isRunningRef.current) return;
      await runProbe();
      if (isRunningRef.current) {
        timerRef.current = setTimeout(tick, interval * 1000);
      }
    };
    tick();
  }, [interval, runProbe]);

  const stopMonitoring = useCallback(() => {
    isRunningRef.current = false;
    setStatus('idle');
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const runDiagnostics = useCallback(async () => {
    setIsRunningDiag(true);
    const results = await runDiagnostic();
    const analysisResults = analyzeProbes(probes);
    setDiagnostics([...results, ...analysisResults]);
    setIsRunningDiag(false);
  }, [probes]);

  const clearData = useCallback(() => {
    setProbes([]);
    localStorage.removeItem(STORAGE_KEY);
    setDiagnostics([]);
  }, []);

  // Online/Offline events
  useEffect(() => {
    const handleOnline = () => {
      setProbes(prev => {
        const probe: NetworkProbe = {
          timestamp: Date.now(),
          latency: null,
          isOnline: true,
          downloadSpeed: null,
          connectionType: 'unknown',
          effectiveType: 'unknown',
          downlink: 0,
          rtt: 0,
          target: 'browser-event',
        };
        const next = [...prev, probe].slice(-MAX_PROBES);
        saveProbes(next);
        return next;
      });
    };
    const handleOffline = () => {
      setProbes(prev => {
        const probe: NetworkProbe = {
          timestamp: Date.now(),
          latency: null,
          isOnline: false,
          downloadSpeed: null,
          connectionType: 'unknown',
          effectiveType: 'unknown',
          downlink: 0,
          rtt: 0,
          target: 'browser-event',
          error: '浏览器检测到离线',
        };
        const next = [...prev, probe].slice(-MAX_PROBES);
        saveProbes(next);
        return next;
      });
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      isRunningRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const stats = computeStats(probes);
  const chartData = probes.slice(-60).map(p => ({
    time: formatTime(p.timestamp),
    latency: p.latency ? Math.round(p.latency) : null,
    speed: p.downloadSpeed,
    online: p.isOnline ? 1 : 0,
  }));

  const isOnline = probes.length > 0 ? probes[probes.length - 1].isOnline : navigator.onLine;
  const lastProbe = probes.length > 0 ? probes[probes.length - 1] : null;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50">
      {/* Header */}
      <header className="bg-white/80 backdrop-blur-sm border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-gradient-to-br from-blue-500 to-purple-600 rounded-xl flex items-center justify-center text-white font-bold text-lg">
              N
            </div>
            <div>
              <h1 className="text-lg font-bold text-gray-800">NetDiag 网络监控</h1>
              <p className="text-xs text-gray-500">长时间网络诊断工具</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <StatusBadge online={isOnline} />
            {status === 'running' && (
              <span className="text-xs text-blue-600 bg-blue-50 px-2 py-1 rounded-full">
                监控中 · 每{interval}秒
              </span>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6 space-y-6">
        {/* Controls */}
        <div className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <label className="text-sm text-gray-600">探测间隔:</label>
              <select
                value={interval}
                onChange={(e) => setIntervalValue(Number(e.target.value))}
                disabled={status === 'running'}
                className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm bg-white disabled:opacity-50"
              >
                <option value={5}>5秒</option>
                <option value={10}>10秒</option>
                <option value={30}>30秒</option>
                <option value={60}>1分钟</option>
                <option value={300}>5分钟</option>
              </select>
            </div>
            
            {status !== 'running' ? (
              <button
                onClick={startMonitoring}
                className="px-5 py-2 bg-gradient-to-r from-blue-500 to-blue-600 text-white rounded-lg text-sm font-medium hover:from-blue-600 hover:to-blue-700 transition-all shadow-sm hover:shadow-md"
              >
                ▶ 开始监控
              </button>
            ) : (
              <button
                onClick={stopMonitoring}
                className="px-5 py-2 bg-gradient-to-r from-red-500 to-red-600 text-white rounded-lg text-sm font-medium hover:from-red-600 hover:to-red-700 transition-all shadow-sm"
              >
                ⏹ 停止监控
              </button>
            )}
            
            <button
              onClick={runDiagnostics}
              disabled={isRunningDiag}
              className="px-5 py-2 bg-gradient-to-r from-purple-500 to-purple-600 text-white rounded-lg text-sm font-medium hover:from-purple-600 hover:to-purple-700 transition-all shadow-sm disabled:opacity-50"
            >
              {isRunningDiag ? '🔄 诊断中...' : '🔍 运行诊断'}
            </button>
            
            <button
              onClick={clearData}
              className="px-4 py-2 border border-gray-200 text-gray-600 rounded-lg text-sm hover:bg-gray-50 transition-colors ml-auto"
            >
              🗑 清除数据
            </button>
          </div>
          
          {probes.length > 0 && (
            <div className="mt-3 pt-3 border-t border-gray-100 text-xs text-gray-500">
              已运行 {formatDuration(Date.now() - stats.startTime)} · 共 {stats.totalProbes} 次探测 · 数据保留在本地浏览器
            </div>
          )}
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
          <StatCard title="在线率" value={`${stats.uptimePercent}%`} icon="📡" color="text-green-500" />
          <StatCard title="平均延迟" value={stats.avgLatency} unit="ms" icon="⏱" color="text-blue-500" />
          <StatCard title="丢包率" value={`${stats.packetLossRate.toFixed(1)}%`} icon="📦" color="text-orange-500" />
          <StatCard title="平均速度" value={stats.avgSpeed} unit="Mbps" icon="⚡" color="text-purple-500" />
          <StatCard title="延迟抖动" value={stats.jitter} unit="ms" icon="📊" color="text-indigo-500" />
          <StatCard title="最大连续失败" value={stats.maxConsecutiveFailures} unit="次" icon="⚠️" color="text-red-500" />
        </div>

        {/* Current Status */}
        {lastProbe && (
          <div className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
            <h3 className="text-sm font-medium text-gray-500 mb-3">最近一次探测详情</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <div>
                <span className="text-gray-400">时间</span>
                <p className="font-medium text-gray-700">{formatTime(lastProbe.timestamp)}</p>
              </div>
              <div>
                <span className="text-gray-400">延迟</span>
                <p className="font-medium text-gray-700">{lastProbe.latency ? `${lastProbe.latency.toFixed(1)}ms` : 'N/A'}</p>
              </div>
              <div>
                <span className="text-gray-400">下载速度</span>
                <p className="font-medium text-gray-700">{lastProbe.downloadSpeed ? `${lastProbe.downloadSpeed} Mbps` : 'N/A'}</p>
              </div>
              <div>
                <span className="text-gray-400">连接类型</span>
                <p className="font-medium text-gray-700">{lastProbe.effectiveType || '未知'}</p>
              </div>
            </div>
          </div>
        )}

        {/* Tabs */}
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
          <div className="flex border-b border-gray-100">
            {[
              { key: 'chart', label: '📈 趋势图表', count: probes.length },
              { key: 'diagnostic', label: '🔍 诊断结果', count: diagnostics.length },
              { key: 'events', label: '📋 事件日志', count: null },
            ].map(tab => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key as any)}
                className={`px-5 py-3 text-sm font-medium transition-colors relative ${
                  activeTab === tab.key 
                    ? 'text-blue-600 bg-blue-50/50' 
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {tab.label}
                {tab.count !== null && (
                  <span className="ml-1.5 text-xs bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded-full">
                    {tab.count}
                  </span>
                )}
                {activeTab === tab.key && (
                  <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-500" />
                )}
              </button>
            ))}
          </div>

          <div className="p-5">
            {/* Chart Tab */}
            {activeTab === 'chart' && (
              <div className="space-y-6">
                {/* Latency Chart */}
                <div>
                  <h4 className="text-sm font-medium text-gray-600 mb-3">延迟趋势 (ms)</h4>
                  <div className="h-56">
                    {chartData.length > 0 ? (
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={chartData}>
                          <defs>
                            <linearGradient id="latencyGradient" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                              <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                            </linearGradient>
                          </defs>
                          <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                          <XAxis dataKey="time" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                          <YAxis tick={{ fontSize: 10 }} />
                          <Tooltip 
                            contentStyle={{ borderRadius: '8px', border: '1px solid #e5e7eb' }}
                            formatter={(value: any) => [value ? `${value}ms` : '失败', '延迟']}
                          />
                          <Area type="monotone" dataKey="latency" stroke="#3b82f6" fill="url(#latencyGradient)" strokeWidth={2} dot={false} connectNulls />
                          <ReferenceLine y={100} stroke="#f59e0b" strokeDasharray="5 5" label={{ value: '警告线 100ms', position: 'right', fontSize: 10 }} />
                          <ReferenceLine y={300} stroke="#ef4444" strokeDasharray="5 5" label={{ value: '危险线 300ms', position: 'right', fontSize: 10 }} />
                        </AreaChart>
                      </ResponsiveContainer>
                    ) : (
                      <div className="h-full flex items-center justify-center text-gray-400">
                        开始监控后将显示延迟趋势图
                      </div>
                    )}
                  </div>
                </div>

                {/* Speed Chart */}
                <div>
                  <h4 className="text-sm font-medium text-gray-600 mb-3">下载速度趋势 (Mbps)</h4>
                  <div className="h-48">
                    {chartData.filter(d => d.speed !== null).length > 0 ? (
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={chartData}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                          <XAxis dataKey="time" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                          <YAxis tick={{ fontSize: 10 }} />
                          <Tooltip 
                            contentStyle={{ borderRadius: '8px', border: '1px solid #e5e7eb' }}
                            formatter={(value: any) => [value ? `${value} Mbps` : 'N/A', '速度']}
                          />
                          <Line type="monotone" dataKey="speed" stroke="#8b5cf6" strokeWidth={2} dot={{ r: 3 }} connectNulls />
                        </LineChart>
                      </ResponsiveContainer>
                    ) : (
                      <div className="h-full flex items-center justify-center text-gray-400">
                        暂无速度数据
                      </div>
                    )}
                  </div>
                </div>

                {/* Online/Offline Bar */}
                <div>
                  <h4 className="text-sm font-medium text-gray-600 mb-3">连接状态时间线</h4>
                  <div className="h-20">
                    {chartData.length > 0 ? (
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={chartData}>
                          <XAxis dataKey="time" tick={{ fontSize: 9 }} interval="preserveStartEnd" />
                          <YAxis hide domain={[0, 1]} />
                          <Tooltip 
                            contentStyle={{ borderRadius: '8px', border: '1px solid #e5e7eb' }}
                            formatter={(value: any) => [value === 1 ? '在线' : '离线', '状态']}
                          />
                          <Bar dataKey="online" fill="#10b981" radius={[2, 2, 0, 0]}>
                            {chartData.map((entry, index) => (
                              <rect key={index} fill={entry.online === 1 ? '#10b981' : '#ef4444'} />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    ) : (
                      <div className="h-full flex items-center justify-center text-gray-400">
                        暂无数据
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Diagnostic Tab */}
            {activeTab === 'diagnostic' && (
              <div>
                {diagnostics.length > 0 ? (
                  <DiagnosticPanel diagnostics={diagnostics} />
                ) : (
                  <div className="text-center py-12 text-gray-400">
                    <p className="text-4xl mb-3">🔍</p>
                    <p>点击"运行诊断"按钮开始网络诊断</p>
                    <p className="text-xs mt-1">诊断将检测DNS、多目标连通性、连接类型等</p>
                  </div>
                )}
              </div>
            )}

            {/* Events Tab */}
            {activeTab === 'events' && (
              <div>
                <EventLog probes={probes} />
              </div>
            )}
          </div>
        </div>

        {/* Help Section */}
        <div className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
          <h3 className="text-sm font-medium text-gray-700 mb-3">💡 使用指南</h3>
          <div className="grid md:grid-cols-2 gap-4 text-sm text-gray-600">
            <div className="space-y-2">
              <p><strong>长时间监控：</strong>点击"开始监控"后，工具会按设定间隔自动探测网络。你可以将其保持在后台运行，数据会自动保存到浏览器本地。</p>
              <p><strong>查看趋势：</strong>在"趋势图表"标签中查看延迟、速度和连接状态的历史变化。</p>
              <p><strong>运行诊断：</strong>点击"运行诊断"会立即检测DNS、多目标连通性等，并给出修复建议。</p>
            </div>
            <div className="space-y-2">
              <p><strong>问题定位：</strong></p>
              <ul className="list-disc list-inside space-y-1 text-xs">
                <li>延迟高但不断连 → 可能是带宽不足或路由问题</li>
                <li>频繁断连又恢复 → 可能是WiFi信号弱或路由器问题</li>
                <li>完全断连 → 检查物理连接和ISP状态</li>
                <li>延迟波动大 → 可能有设备在占用带宽</li>
                <li>丢包率高 → 网线问题、WiFi干扰或ISP问题</li>
              </ul>
            </div>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="text-center py-4 text-xs text-gray-400">
        NetDiag 网络监控诊断工具 · 数据仅保存在本地浏览器 · 关闭页面后数据不会丢失
      </footer>
    </div>
  );
}
