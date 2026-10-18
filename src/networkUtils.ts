import { NetworkProbe, DiagnosticResult } from './types';

// 多个目标用于诊断，帮助定位问题所在
const TARGETS = [
  { name: 'Cloudflare DNS', url: 'https://1.1.1.1/cdn-cgi/trace', type: 'dns' },
  { name: 'Google', url: 'https://www.google.com/favicon.ico', type: 'international' },
  { name: 'Baidu', url: 'https://www.baidu.com/favicon.ico', type: 'domestic' },
];

export async function measureLatency(target: string = 'https://www.baidu.com/favicon.ico'): Promise<{ latency: number | null; error?: string }> {
  const startTime = performance.now();
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    
    const response = await fetch(target + '?_=' + Date.now(), {
      method: 'HEAD',
      mode: 'no-cors',
      cache: 'no-store',
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);
    const endTime = performance.now();
    const latency = endTime - startTime;
    return { latency };
  } catch (err: any) {
    return { latency: null, error: err.message || '连接失败' };
  }
}

export async function measureDownloadSpeed(): Promise<number | null> {
  try {
    // 使用一个小的测试文件来估算速度
    const testUrl = 'https://speed.cloudflare.com/__down?bytes=1000000';
    const startTime = performance.now();
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    
    const response = await fetch(testUrl, {
      cache: 'no-store',
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);
    const endTime = performance.now();
    
    if (!response.ok) return null;
    
    const blob = await response.blob();
    const duration = (endTime - startTime) / 1000; // seconds
    const bits = blob.size * 8;
    const mbps = (bits / duration) / (1024 * 1024);
    
    return Math.round(mbps * 100) / 100;
  } catch {
    return null;
  }
}

export async function runFullProbe(): Promise<NetworkProbe> {
  const connection = (navigator as any).connection || (navigator as any).mozConnection || (navigator as any).webkitConnection;
  
  const { latency, error } = await measureLatency();
  const isOnline = navigator.onLine && latency !== null;
  
  let downloadSpeed: number | null = null;
  if (isOnline) {
    downloadSpeed = await measureDownloadSpeed();
  }
  
  return {
    timestamp: Date.now(),
    latency,
    isOnline,
    downloadSpeed,
    connectionType: connection?.type || 'unknown',
    effectiveType: connection?.effectiveType || 'unknown',
    downlink: connection?.downlink || 0,
    rtt: connection?.rtt || 0,
    target: 'Cloudflare',
    error,
  };
}

export async function runDiagnostic(): Promise<DiagnosticResult[]> {
  const results: DiagnosticResult[] = [];
  
  // 1. 基础连接检测
  results.push({
    id: 'online-status',
    timestamp: Date.now(),
    type: navigator.onLine ? 'success' : 'error',
    title: '基础连接状态',
    description: navigator.onLine ? '浏览器检测到网络连接正常' : '浏览器检测到网络已断开',
    suggestion: !navigator.onLine ? '请检查网线/WiFi连接，确认路由器是否正常工作' : undefined,
  });
  
  // 2. 多目标检测
  for (const target of TARGETS) {
    const { latency, error } = await measureLatency(target.url);
    results.push({
      id: `target-${target.type}`,
      timestamp: Date.now(),
      type: latency !== null ? (latency < 200 ? 'success' : 'warning') : 'error',
      title: `${target.name} 连通性`,
      description: latency !== null 
        ? `延迟: ${latency.toFixed(1)}ms` 
        : `无法连接: ${error || '超时'}`,
      suggestion: latency === null 
        ? `无法访问${target.name}，可能是DNS问题或该服务不可达` 
        : latency > 500 
          ? '延迟过高，可能存在网络拥塞或路由问题' 
          : undefined,
    });
  }
  
  // 3. 连接类型检测
  const connection = (navigator as any).connection;
  if (connection) {
    const isGood = connection.effectiveType === '4g' || connection.effectiveType === '3g';
    results.push({
      id: 'connection-type',
      timestamp: Date.now(),
      type: isGood ? 'success' : 'warning',
      title: '连接类型',
      description: `类型: ${connection.effectiveType || '未知'}, 下行: ${connection.downlink || '未知'}Mbps, RTT: ${connection.rtt || '未知'}ms`,
      suggestion: !isGood ? '当前网络类型较慢(2G/慢速3G)，建议切换到更好的网络' : undefined,
    });
  } else {
    results.push({
      id: 'connection-type',
      timestamp: Date.now(),
      type: 'info',
      title: '连接类型',
      description: '浏览器不支持 Network Information API，无法获取详细连接信息',
    });
  }
  
  // 4. DNS 检测 (通过 Cloudflare trace)
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const response = await fetch('https://1.1.1.1/cdn-cgi/trace', { 
      cache: 'no-store',
      signal: controller.signal 
    });
    clearTimeout(timeoutId);
    const text = await response.text();
    const locMatch = text.match(/loc=(\w+)/);
    const ipMatch = text.match(/ip=(.+)/);
    const coloMatch = text.match(/colo=(\w+)/);
    
    results.push({
      id: 'dns-check',
      timestamp: Date.now(),
      type: 'success',
      title: 'DNS 解析',
      description: `DNS解析正常 | IP: ${ipMatch?.[1] || '未知'} | 位置: ${locMatch?.[1] || '未知'} | 节点: ${coloMatch?.[1] || '未知'}`,
    });
  } catch {
    results.push({
      id: 'dns-check',
      timestamp: Date.now(),
      type: 'error',
      title: 'DNS 解析',
      description: 'DNS解析失败，可能DNS服务器不可达',
      suggestion: '尝试更换DNS服务器为 8.8.8.8 (Google) 或 114.114.114.114',
    });
  }
  
  return results;
}

export function analyzeProbes(probes: NetworkProbe[]): DiagnosticResult[] {
  const results: DiagnosticResult[] = [];
  if (probes.length < 3) return results;
  
  const recentProbes = probes.slice(-30);
  const failedProbes = recentProbes.filter(p => !p.isOnline);
  const successProbes = recentProbes.filter(p => p.isOnline && p.latency !== null);
  
  // 丢包率分析
  const lossRate = (failedProbes.length / recentProbes.length) * 100;
  if (lossRate > 20) {
    results.push({
      id: 'analysis-loss-high',
      timestamp: Date.now(),
      type: 'error',
      title: '⚠️ 高丢包率',
      description: `最近30次探测中丢包率高达 ${lossRate.toFixed(1)}%`,
      suggestion: '丢包率过高，可能原因：1) WiFi信号弱 2) 路由器负载过高 3) ISP问题 4) 网线接触不良',
    });
  } else if (lossRate > 5) {
    results.push({
      id: 'analysis-loss-medium',
      timestamp: Date.now(),
      type: 'warning',
      title: '⚡ 中等丢包率',
      description: `最近30次探测中丢包率为 ${lossRate.toFixed(1)}%`,
      suggestion: '存在一定丢包，建议检查WiFi信号强度或尝试有线连接',
    });
  }
  
  // 延迟分析
  if (successProbes.length > 0) {
    const latencies = successProbes.map(p => p.latency!).filter(l => l !== null);
    const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    const maxLatency = Math.max(...latencies);
    const minLatency = Math.min(...latencies);
    const jitter = maxLatency - minLatency;
    
    if (avgLatency > 300) {
      results.push({
        id: 'analysis-latency-high',
        timestamp: Date.now(),
        type: 'error',
        title: '🐌 高延迟',
        description: `平均延迟 ${avgLatency.toFixed(0)}ms，最高 ${maxLatency.toFixed(0)}ms`,
        suggestion: '延迟过高，可能原因：1) 距离服务器太远 2) 网络拥塞 3) 路由器性能不足',
      });
    }
    
    if (jitter > 500) {
      results.push({
        id: 'analysis-jitter',
        timestamp: Date.now(),
        type: 'warning',
        title: '📊 延迟波动大',
        description: `延迟波动范围: ${minLatency.toFixed(0)}ms ~ ${maxLatency.toFixed(0)}ms (抖动 ${jitter.toFixed(0)}ms)`,
        suggestion: '延迟波动大说明网络不稳定，可能是WiFi干扰或带宽被其他设备占用',
      });
    }
  }
  
  // 断连分析
  let maxConsecutive = 0;
  let currentConsecutive = 0;
  for (const probe of recentProbes) {
    if (!probe.isOnline) {
      currentConsecutive++;
      maxConsecutive = Math.max(maxConsecutive, currentConsecutive);
    } else {
      currentConsecutive = 0;
    }
  }
  
  if (maxConsecutive >= 3) {
    results.push({
      id: 'analysis-disconnect',
      timestamp: Date.now(),
      type: 'error',
      title: '🔌 频繁断连',
      description: `最近出现连续 ${maxConsecutive} 次探测失败`,
      suggestion: '频繁断连可能原因：1) 路由器需要重启 2) ISP服务不稳定 3) 网线/接头松动 4) 路由器固件需要更新',
    });
  }
  
  // 速度分析
  const speedProbes = recentProbes.filter(p => p.downloadSpeed !== null);
  if (speedProbes.length > 0) {
    const avgSpeed = speedProbes.reduce((a, p) => a + (p.downloadSpeed || 0), 0) / speedProbes.length;
    if (avgSpeed < 1) {
      results.push({
        id: 'analysis-speed-low',
        timestamp: Date.now(),
        type: 'warning',
        title: '🐢 网速较慢',
        description: `平均下载速度仅 ${avgSpeed.toFixed(2)} Mbps`,
        suggestion: '网速较慢，建议：1) 检查是否有其他设备占用带宽 2) 联系ISP确认套餐速度 3) 尝试重启路由器',
      });
    }
  }
  
  return results;
}
