import { readFile, statfs } from 'node:fs/promises';
import os from 'node:os';
import {
  clampPct,
  cpuPercent,
  parseLoadavg,
  parseMeminfo,
  parseMounts,
  parseNetDev,
  parseOsRelease,
  parseProcStat,
  parseUptime,
  type CpuTimes,
  type NetCounters,
} from './proc.ts';

export interface DiskUsage {
  mountpoint: string;
  device: string;
  fstype: string;
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  usedPercent: number;
}

export interface Snapshot {
  collectedAt: number;
  cpu: { percent: number; cores: number[]; count: number };
  load: [number, number, number];
  memory: {
    totalBytes: number;
    usedBytes: number;
    availableBytes: number;
    buffersCacheBytes: number;
    usedPercent: number;
    swapTotalBytes: number;
    swapUsedBytes: number;
  };
  disks: DiskUsage[];
  network: { rxBytesPerSec: number; txBytesPerSec: number; interfaces: string[] } | null;
  uptimeSeconds: number;
}

export interface HistoryPoint {
  t: number;
  cpu: number;
  mem: number;
  disk: number;
  rx: number;
  tx: number;
}

export interface HostInfo {
  hostname: string;
  os: { name: string; version: string; id: string; prettyName: string };
  kernel: string;
  arch: string;
  cpuModel: string;
  cpuCount: number;
  supported: boolean;
  supportNote: string | null;
}

export interface Sources {
  read(path: string): Promise<string>;
  statfs(path: string): Promise<{ blocks: number; bsize: number; bfree: number; bavail: number }>;
}

export const realSources: Sources = {
  read: (p) => readFile(p, 'utf8'),
  statfs: async (p) => {
    const s = await statfs(p);
    return { blocks: Number(s.blocks), bsize: Number(s.bsize), bfree: Number(s.bfree), bavail: Number(s.bavail) };
  },
};

/**
 * Lightweight metrics sampler. Reads a handful of small /proc files every
 * interval (no subprocesses), keeps the latest snapshot plus a bounded
 * in-memory history ring for sparklines.
 */
export class MetricsCollector {
  private prevCpu: { total: CpuTimes; cores: CpuTimes[] } | null = null;
  private prevNet: { at: number; counters: NetCounters[] } | null = null;
  private latest: Snapshot | null = null;
  private readonly ring: HistoryPoint[] = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly linux: boolean;
  private readonly src: Sources;
  private readonly intervalMs: number;
  private readonly maxPoints: number;
  lastError: string | null = null;

  constructor(opts: { intervalSeconds: number; historyMinutes: number; sources?: Sources; linux?: boolean }) {
    this.src = opts.sources ?? realSources;
    this.linux = opts.linux ?? process.platform === 'linux';
    this.intervalMs = opts.intervalSeconds * 1000;
    this.maxPoints = Math.ceil((opts.historyMinutes * 60) / opts.intervalSeconds);
  }

  start(): void {
    if (this.timer) return;
    void this.sample();
    this.timer = setInterval(() => void this.sample(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get intervalSeconds(): number {
    return this.intervalMs / 1000;
  }

  snapshot(): Snapshot | null {
    return this.latest;
  }

  history(): HistoryPoint[] {
    return this.ring.slice();
  }

  async sample(now = Date.now()): Promise<Snapshot | null> {
    try {
      const snap = this.linux ? await this.sampleLinux(now) : await this.sampleGeneric(now);
      this.latest = snap;
      this.lastError = null;
      const root = snap.disks.find((d) => d.mountpoint === '/') ?? snap.disks[0];
      this.ring.push({
        t: now,
        cpu: snap.cpu.percent,
        mem: snap.memory.usedPercent,
        disk: root?.usedPercent ?? 0,
        rx: snap.network?.rxBytesPerSec ?? 0,
        tx: snap.network?.txBytesPerSec ?? 0,
      });
      while (this.ring.length > this.maxPoints) this.ring.shift();
      return snap;
    } catch (e) {
      this.lastError = (e as Error).message;
      return null;
    }
  }

  private async sampleLinux(now: number): Promise<Snapshot> {
    const [stat, meminfo, loadavg, uptime, netdev, mounts] = await Promise.all([
      this.src.read('/proc/stat'),
      this.src.read('/proc/meminfo'),
      this.src.read('/proc/loadavg'),
      this.src.read('/proc/uptime'),
      this.src.read('/proc/net/dev').catch(() => ''),
      this.src.read('/proc/mounts').catch(() => ''),
    ]);

    const cpu = parseProcStat(stat);
    let percent = 0;
    let cores: number[] = cpu.cores.map(() => 0);
    if (this.prevCpu) {
      percent = cpuPercent(this.prevCpu.total, cpu.total);
      const prevCores = this.prevCpu.cores;
      cores = cpu.cores.map((c, i) => (prevCores[i] ? cpuPercent(prevCores[i], c) : 0));
    }
    this.prevCpu = cpu;

    const mem = parseMeminfo(meminfo);

    let network: Snapshot['network'] = null;
    if (netdev) {
      const counters = parseNetDev(netdev);
      if (this.prevNet && now > this.prevNet.at) {
        const secs = (now - this.prevNet.at) / 1000;
        let rx = 0;
        let tx = 0;
        for (const c of counters) {
          const p = this.prevNet.counters.find((x) => x.iface === c.iface);
          if (!p) continue;
          // Counter reset (interface restart) yields a negative delta: skip it.
          rx += Math.max(0, c.rxBytes - p.rxBytes);
          tx += Math.max(0, c.txBytes - p.txBytes);
        }
        network = { rxBytesPerSec: Math.round(rx / secs), txBytesPerSec: Math.round(tx / secs), interfaces: counters.map((c) => c.iface) };
      } else {
        network = { rxBytesPerSec: 0, txBytesPerSec: 0, interfaces: counters.map((c) => c.iface) };
      }
      this.prevNet = { at: now, counters };
    }

    const mountList = mounts ? parseMounts(mounts) : [];
    if (!mountList.some((m) => m.mountpoint === '/')) mountList.unshift({ device: 'rootfs', mountpoint: '/', fstype: 'unknown' });
    const disks = await this.disks(mountList);

    return {
      collectedAt: now,
      cpu: { percent, cores, count: cpu.cores.length || os.cpus().length },
      load: parseLoadavg(loadavg),
      memory: {
        totalBytes: mem.totalBytes,
        usedBytes: mem.usedBytes,
        availableBytes: mem.availableBytes,
        buffersCacheBytes: mem.buffersCacheBytes,
        usedPercent: mem.totalBytes ? clampPct((mem.usedBytes / mem.totalBytes) * 100) : 0,
        swapTotalBytes: mem.swapTotalBytes,
        swapUsedBytes: mem.swapUsedBytes,
      },
      disks,
      network,
      uptimeSeconds: parseUptime(uptime),
    };
  }

  /** Fallback for development on macOS/other platforms using the os module. */
  private async sampleGeneric(now: number): Promise<Snapshot> {
    const cpus = os.cpus();
    const total: CpuTimes = { idle: 0, total: 0 };
    const cores = cpus.map((c) => {
      const t = c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
      total.idle += c.times.idle;
      total.total += t;
      return { idle: c.times.idle, total: t };
    });
    const cur = { total, cores };
    const percent = this.prevCpu ? cpuPercent(this.prevCpu.total, total) : 0;
    const corePct = this.prevCpu ? cores.map((c, i) => (this.prevCpu!.cores[i] ? cpuPercent(this.prevCpu!.cores[i]!, c) : 0)) : cores.map(() => 0);
    this.prevCpu = cur;
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    return {
      collectedAt: now,
      cpu: { percent, cores: corePct, count: cpus.length },
      load: os.loadavg() as [number, number, number],
      memory: {
        totalBytes: totalMem,
        usedBytes: totalMem - freeMem,
        availableBytes: freeMem,
        buffersCacheBytes: 0,
        usedPercent: clampPct(((totalMem - freeMem) / totalMem) * 100),
        swapTotalBytes: 0,
        swapUsedBytes: 0,
      },
      disks: await this.disks([{ device: 'root', mountpoint: '/', fstype: 'unknown' }]),
      network: null,
      uptimeSeconds: Math.floor(os.uptime()),
    };
  }

  private async disks(mounts: { device: string; mountpoint: string; fstype: string }[]): Promise<DiskUsage[]> {
    const out: DiskUsage[] = [];
    for (const m of mounts.slice(0, 16)) {
      try {
        const s = await this.src.statfs(m.mountpoint);
        const totalBytes = s.blocks * s.bsize;
        if (totalBytes === 0) continue;
        const availableBytes = s.bavail * s.bsize;
        const usedBytes = (s.blocks - s.bfree) * s.bsize;
        // Like df: percentage of space usable by non-root users.
        const denom = usedBytes + availableBytes;
        out.push({
          mountpoint: m.mountpoint,
          device: m.device,
          fstype: m.fstype,
          totalBytes,
          usedBytes,
          availableBytes,
          usedPercent: denom ? clampPct((usedBytes / denom) * 100) : 0,
        });
      } catch {
        /* unreadable mount (permissions, stale NFS): skip */
      }
    }
    return out;
  }
}

/** Supported targets for this release (NFR 7.4). Others run, but are flagged. */
export const SUPPORTED = { osId: 'ubuntu', versions: ['24.04'], arch: ['x64'] };

export async function hostInfo(src: Sources = realSources): Promise<HostInfo> {
  let rel: Record<string, string> = {};
  try {
    rel = parseOsRelease(await src.read('/etc/os-release'));
  } catch {
    /* not Linux, or unreadable */
  }
  const osInfo = {
    name: rel.NAME ?? os.type(),
    version: rel.VERSION_ID ?? os.release(),
    id: rel.ID ?? process.platform,
    prettyName: rel.PRETTY_NAME ?? `${os.type()} ${os.release()}`,
  };
  const arch = process.arch;
  let note: string | null = null;
  if (osInfo.id !== SUPPORTED.osId || !SUPPORTED.versions.includes(osInfo.version)) {
    note = `${osInfo.prettyName} is not a supported OS for this release (supported: Ubuntu ${SUPPORTED.versions.join(', ')} LTS).`;
  } else if (!SUPPORTED.arch.includes(arch)) {
    note = `Architecture ${arch} is not yet tested (supported: x86-64).`;
  }
  const cpus = os.cpus();
  return {
    hostname: os.hostname(),
    os: osInfo,
    kernel: os.release(),
    arch,
    cpuModel: cpus[0]?.model.trim() ?? 'unknown',
    cpuCount: cpus.length,
    supported: note === null,
    supportNote: note,
  };
}
