import { NetworkProbe, DiagnosticResult } from './types';

// 多目标检测策略：
// - 直连目标（不走代理）：用于检测真实网络状态
// - 代理目标（走代理）：用于检测代理是否正常工作
// 通过对比两者来判断问题出在哪一层
const DIRECT_TARGETS = [
  { name: 'Cloudflare Trace (直连)', url: 'https://1.1.1.1/cdn-cgi/trace', bypassProxy: true },
  { name: 'Baidu (国内直连)', url: 'https://www.baidu.com/favicon.ico', bypassProxy: true },
];

const PROXY_TARGETS = [
  { name: 'Google (代理)', url: 'https://www.google.com/favicon.ico', bypassProxy: false },
  { name: 'GitHub (代理)', url: 'https://github.com/favicon.ico', bypassProxy: false },
];

// 检测是否存在 TUN 代理
export async function detectProxy(): Promise<{ hasProxy: boolean; proxyInfo: string }> {
  try {
    // 通过 Cloudflare trace 检测 IP 和位置
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const response = await fetch('https://1.1.1.1/cdn-cgi/trace', {
      cache: 'no-store',
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    const text = await response.text();
    const ipMatch = text.match(/ip=(.+)/);
    const locMatch = text.match(/loc=(\w+)/);
    const coloMatch = text.match(/colo=(\w+)/);
    const warpMatch = text.match(/warp=(\w+)/);
    
    // 获取浏览器端看到的 IP (通过另一个服务)
    let browserIp = '';
    try {
      const ipResp = await fetch('https://api.ipify.org?format=json', { cache: 'no-store' });
      const ipData = await ipResp.json();
      browserIp = ipData.ip || '';
    } catch { /* ignore */ }
    
    const cfIp = ipMatch?.[1] || '';
    
    // 如果两个 IP 不同，说明有代理
    const hasProxy = Boolean(browserIp && cfIp && browserIp !== cfIp);
    
    let proxyInfo = `出口IP: ${cfIp} | 位置: ${locMatch?.[1] || '?'} | 节点: ${coloMatch?.[1] || '?'}`;
    if (warpMatch?.[1] === 'on') {
      proxyInfo += ' | WARP: 开启';
    }
    if (hasProxy) {
      proxyInfo += ` | ⚡ 检测到代理 (浏览器IP: ${browserIp})`;
    }
    
    return { hasProxy, proxyInfo };
  } catch {
    return { hasProxy: false, proxyInfo: '无法检测' };
  }
}

export async function measureLatency(target: string, _bypassProxy?: boolean): Promise<{ latency: number | null; error?: string }> {
  const startTime = performance.now();
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    
    // 注意：浏览器中无法真正绕过 TUN 代理
    // TUN 模式在系统层面接管所有流量，fetch 无法选择走不走代理
    // 但我们可以标记哪些目标是"通常不走代理的"
    const fetchOptions: RequestInit = {
      method: 'HEAD',
      mode: 'no-cors',
      cache: 'no-store',
      signal: controller.signal,
    };
    
    const response = await fetch(target + '?_=' + Date.now(), fetchOptions);
    clearTimeout(timeoutId);
    const endTime = performance.now();
    const latency = endTime - startTime;
    return { latency };
  } catch (err: any) {
    return { latency: null, error: err.name === 'AbortError' ? '请求超时(10s)' : (err.message || '连接失败') };
  }
}

export async function measureDownloadSpeed(): Promise<number | null> {
  try {
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
    const duration = (endTime - startTime) / 1000;
    const bits = blob.size * 8;
    const mbps = (bits / duration) / (1024 * 1024);
    
    return Math.round(mbps * 100) / 100;
  } catch {
    return null;
  }
}

export async function runFullProbe(): Promise<NetworkProbe> {
  const connection = (navigator as any).connection || (navigator as any).mozConnection || (navigator as any).webkitConnection;
  
  // 同时测试多个目标
  const [directResult, proxyResult] = await Promise.all([
    measureLatency(DIRECT_TARGETS[0].url, true),
    measureLatency(PROXY_TARGETS[0].url, false),
  ]);
  
  // 使用直连目标的延迟（如果可用），否则用代理目标
  const latency = directResult.latency ?? proxyResult.latency;
  const isOnline = navigator.onLine && (directResult.latency !== null || proxyResult.latency !== null);
  
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
    target: 'multi-target',
    error: !isOnline ? (directResult.error || proxyResult.error) : undefined,
  };
}

export async function runDiagnostic(): Promise<DiagnosticResult[]> {
  const results: DiagnosticResult[] = [];
  
  // 0. 代理检测
  const { hasProxy, proxyInfo } = await detectProxy();
  results.push({
    id: 'proxy-detect',
    timestamp: Date.now(),
    type: hasProxy ? 'info' : 'success',
    title: hasProxy ? '🔀 检测到代理/VPN' : '✅ 未检测到代理',
    description: proxyInfo,
    suggestion: hasProxy 
      ? '当前有代理运行。注意：浏览器测量到的延迟包含代理开销，无法区分代理问题和真实网络问题。如果频繁断连，建议先关闭代理测试真实网络。'
      : '当前为直连状态，测量结果反映真实网络情况。',
  });
  
  // 1. 基础连接检测
  results.push({
    id: 'online-status',
    timestamp: Date.now(),
    type: navigator.onLine ? 'success' : 'error',
    title: '基础连接状态',
    description: navigator.onLine ? '浏览器检测到网络连接正常' : '浏览器检测到网络已断开',
    suggestion: !navigator.onLine ? '请检查网线/WiFi连接，确认路由器是否正常工作。如果使用TUN代理，也请检查代理软件状态。' : undefined,
  });
  
  // 2. 直连目标检测
  for (const target of DIRECT_TARGETS) {
    const { latency, error } = await measureLatency(target.url, true);
    results.push({
      id: `direct-${target.name}`,
      timestamp: Date.now(),
      type: latency !== null ? (latency < 200 ? 'success' : 'warning') : 'error',
      title: `🌐 ${target.name}`,
      description: latency !== null 
        ? `延迟: ${latency.toFixed(1)}ms — 直连可达` 
        : `无法连接: ${error || '超时'}`,
      suggestion: latency === null 
        ? '直连目标不可达，说明真实网络可能有问题（或者该目标被防火墙屏蔽）' 
        : latency > 500 
          ? '直连延迟过高，真实网络质量较差' 
          : undefined,
    });
  }
  
  // 3. 代理目标检测
  for (const target of PROXY_TARGETS) {
    const { latency, error } = await measureLatency(target.url, false);
    results.push({
      id: `proxy-${target.name}`,
      timestamp: Date.now(),
      type: latency !== null ? (latency < 300 ? 'success' : 'warning') : 'error',
      title: `🔀 ${target.name}`,
      description: latency !== null 
        ? `延迟: ${latency.toFixed(1)}ms — 经代理可达` 
        : `无法连接: ${error || '超时'}`,
      suggestion: latency === null 
        ? '代理目标不可达，代理可能已断开或节点不可用' 
        : latency > 500 
          ? '代理延迟过高，代理节点可能拥堵或距离太远' 
          : undefined,
    });
  }
  
  // 4. 对比分析
  const directResults = await Promise.all(DIRECT_TARGETS.map(t => measureLatency(t.url, true)));
  const proxyResults = await Promise.all(PROXY_TARGETS.map(t => measureLatency(t.url, false)));
  
  const directAllOk = directResults.every(r => r.latency !== null);
  const proxyAllOk = proxyResults.every(r => r.latency !== null);
  const directAnyOk = directResults.some(r => r.latency !== null);
  const proxyAnyOk = proxyResults.some(r => r.latency !== null);
  
  if (hasProxy) {
    if (directAllOk && !proxyAnyOk) {
      results.push({
        id: 'analysis-proxy-down',
        timestamp: Date.now(),
        type: 'error',
        title: '❌ 代理故障',
        description: '直连正常但代理目标全部不可达',
        suggestion: '问题出在代理软件/节点上。真实网络是正常的。请检查：1) 代理软件是否运行 2) 订阅是否过期 3) 切换节点试试',
      });
    } else if (!directAnyOk && proxyAllOk) {
      results.push({
        id: 'analysis-real-down',
        timestamp: Date.now(),
        type: 'error',
        title: '❌ 真实网络故障',
        description: '代理目标可达但直连全部失败',
        suggestion: '真实网络可能有问题，但代理节点缓存/长连接还在。请检查：1) 网线/WiFi 2) 路由器 3) 联系ISP',
      });
    } else if (!directAnyOk && !proxyAnyOk) {
      results.push({
        id: 'analysis-all-down',
        timestamp: Date.now(),
        type: 'error',
        title: '❌ 完全断网',
        description: '直连和代理目标均不可达',
        suggestion: '网络完全中断。请检查：1) 网线/WiFi连接 2) 路由器是否工作 3) 光猫状态 4) 联系ISP确认是否故障',
      });
    } else if (directAllOk && proxyAllOk) {
      const directAvg = directResults.reduce((a, r) => a + (r.latency || 0), 0) / directResults.length;
      const proxyAvg = proxyResults.reduce((a, r) => a + (r.latency || 0), 0) / proxyResults.length;
      const overhead = proxyAvg - directAvg;
      
      results.push({
        id: 'analysis-all-ok',
        timestamp: Date.now(),
        type: 'success',
        title: '✅ 网络正常',
        description: `直连和代理均正常。代理额外开销: ${overhead.toFixed(0)}ms`,
        suggestion: overhead > 200 
          ? '代理额外延迟超过200ms，建议使用更近的节点' 
          : undefined,
      });
    }
  }
  
  // 5. 连接类型检测
  const connection = (navigator as any).connection;
  if (connection) {
    const isGood = connection.effectiveType === '4g' || connection.effectiveType === '3g';
    results.push({
      id: 'connection-type',
      timestamp: Date.now(),
      type: isGood ? 'success' : 'warning',
      title: '📶 连接类型',
      description: `类型: ${connection.effectiveType || '未知'}, 下行: ${connection.downlink || '未知'}Mbps, RTT: ${connection.rtt || '未知'}ms`,
      suggestion: !isGood ? '当前网络类型较慢，建议切换到更好的网络' : undefined,
    });
  }
  
  // 6. DNS 检测
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
    const tlsMatch = text.match(/tls=(\w+)/);
    
    results.push({
      id: 'dns-check',
      timestamp: Date.now(),
      type: 'success',
      title: '🌍 DNS & 出口信息',
      description: `IP: ${ipMatch?.[1] || '?'} | 位置: ${locMatch?.[1] || '?'} | 节点: ${coloMatch?.[1] || '?'} | TLS: ${tlsMatch?.[1] || '?'}`,
    });
  } catch {
    results.push({
      id: 'dns-check',
      timestamp: Date.now(),
      type: 'error',
      title: 'DNS 解析',
      description: 'DNS解析失败',
      suggestion: '尝试更换DNS服务器为 8.8.8.8 (Google) 或 114.114.114.114。如果使用TUN代理，检查代理的DNS配置。',
    });
  }
  
  // 7. TUN 代理专项提示
  if (hasProxy) {
    results.push({
      id: 'tun-notice',
      timestamp: Date.now(),
      type: 'info',
      title: 'ℹ️ TUN 代理注意事项',
      description: 'TUN模式会在系统层面创建虚拟网卡接管所有流量。浏览器中的fetch请求无法绕过TUN代理，因此所有测量结果都包含代理开销。',
      suggestion: '如需测试真实网络质量：1) 临时关闭TUN模式 2) 使用系统规则模式（仅代理被墙网站）3) 或使用命令行 ping/traceroute 工具',
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
      suggestion: '丢包率过高。可能原因：1) WiFi信号弱 2) 路由器负载过高 3) ISP问题 4) 代理节点不稳定 5) 网线接触不良。建议先关闭代理测试排除代理因素。',
    });
  } else if (lossRate > 5) {
    results.push({
      id: 'analysis-loss-medium',
      timestamp: Date.now(),
      type: 'warning',
      title: '⚡ 中等丢包率',
      description: `最近30次探测中丢包率为 ${lossRate.toFixed(1)}%`,
      suggestion: '存在一定丢包。如果使用TUN代理，可能是代理节点问题。建议切换节点或临时关闭代理对比测试。',
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
        suggestion: '延迟过高。注意：如果使用了代理，这个延迟包含代理开销。关闭代理后重新测试以确认是否为真实网络问题。',
      });
    }
    
    if (jitter > 500) {
      results.push({
        id: 'analysis-jitter',
        timestamp: Date.now(),
        type: 'warning',
        title: '📊 延迟波动大',
        description: `延迟波动范围: ${minLatency.toFixed(0)}ms ~ ${maxLatency.toFixed(0)}ms (抖动 ${jitter.toFixed(0)}ms)`,
        suggestion: '延迟波动大说明网络不稳定。可能原因：WiFi干扰、带宽被占用、代理节点切换、ISP调度变化。',
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
      suggestion: '频繁断连。如果使用TUN代理：1) 检查代理软件是否崩溃/重启 2) 节点是否频繁切换 3) 规则是否导致循环。如果关闭代理后正常，问题在代理。',
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
        suggestion: '网速较慢。注意速度测试走的是Cloudflare节点，如果使用了代理，速度受代理节点限制。',
      });
    }
  }
  
  return results;
}
