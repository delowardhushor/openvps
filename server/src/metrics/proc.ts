/**
 * Pure parsers for Linux /proc and /etc files. Kept free of I/O so they can be
 * unit-tested against fixtures.
 */

export interface CpuTimes {
  idle: number;
  total: number;
}

/** Parse the aggregate and per-core lines of /proc/stat. */
export function parseProcStat(text: string): { total: CpuTimes; cores: CpuTimes[] } {
  let total: CpuTimes | null = null;
  const cores: CpuTimes[] = [];
  for (const line of text.split('\n')) {
    const m = /^cpu(\d*)\s+(.+)$/.exec(line);
    if (!m) continue;
    const f = m[2]!.trim().split(/\s+/).map(Number);
    // user nice system idle iowait irq softirq steal guest guest_nice
    // guest and guest_nice are already included in user/nice, so exclude them.
    const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = f;
    const t: CpuTimes = { idle: idle + iowait, total: user + nice + system + idle + iowait + irq + softirq + steal };
    if (m[1] === '') total = t;
    else cores.push(t);
  }
  if (!total) throw new Error('No aggregate cpu line in /proc/stat');
  return { total, cores };
}

/** CPU utilisation in percent between two samples. */
export function cpuPercent(prev: CpuTimes, cur: CpuTimes): number {
  const dt = cur.total - prev.total;
  const di = cur.idle - prev.idle;
  if (dt <= 0) return 0;
  return clampPct(((dt - di) / dt) * 100);
}

export function clampPct(n: number): number {
  return Math.round(Math.min(100, Math.max(0, n)) * 10) / 10;
}

export interface MemInfo {
  totalBytes: number;
  availableBytes: number;
  usedBytes: number;
  buffersCacheBytes: number;
  swapTotalBytes: number;
  swapUsedBytes: number;
}

export function parseMeminfo(text: string): MemInfo {
  const kv = new Map<string, number>();
  for (const line of text.split('\n')) {
    const m = /^(\w+(?:\(\w+\))?):\s+(\d+)(?:\s+kB)?/.exec(line);
    if (m) kv.set(m[1]!, Number(m[2]) * 1024);
  }
  const total = kv.get('MemTotal') ?? 0;
  const free = kv.get('MemFree') ?? 0;
  const buffers = kv.get('Buffers') ?? 0;
  const cached = (kv.get('Cached') ?? 0) + (kv.get('SReclaimable') ?? 0);
  // MemAvailable exists since Linux 3.14; fall back to an estimate otherwise.
  const available = kv.get('MemAvailable') ?? free + buffers + cached;
  const swapTotal = kv.get('SwapTotal') ?? 0;
  const swapFree = kv.get('SwapFree') ?? 0;
  return {
    totalBytes: total,
    availableBytes: available,
    usedBytes: Math.max(0, total - available),
    buffersCacheBytes: buffers + cached,
    swapTotalBytes: swapTotal,
    swapUsedBytes: Math.max(0, swapTotal - swapFree),
  };
}

export function parseLoadavg(text: string): [number, number, number] {
  const [a, b, c] = text.trim().split(/\s+/).map(Number);
  return [a ?? 0, b ?? 0, c ?? 0];
}

export function parseUptime(text: string): number {
  return Math.floor(Number(text.trim().split(/\s+/)[0]) || 0);
}

export interface NetCounters {
  iface: string;
  rxBytes: number;
  txBytes: number;
}

const VIRTUAL_IFACE = /^(lo|ifb|dummy|docker\d*|veth|br-|virbr|tun|tap|wg|cni|flannel|cali|kube)/;

export function parseNetDev(text: string, includeVirtual = false): NetCounters[] {
  const out: NetCounters[] = [];
  for (const line of text.split('\n').slice(2)) {
    const m = /^\s*([^:\s]+):\s*(.+)$/.exec(line);
    if (!m) continue;
    const iface = m[1]!;
    if (!includeVirtual && VIRTUAL_IFACE.test(iface)) continue;
    const f = m[2]!.trim().split(/\s+/).map(Number);
    out.push({ iface, rxBytes: f[0] ?? 0, txBytes: f[8] ?? 0 });
  }
  return out;
}

export interface Mount {
  device: string;
  mountpoint: string;
  fstype: string;
}

const REAL_FS = new Set(['ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'zfs', 'f2fs', 'jfs', 'reiserfs', 'vfat', 'exfat', 'ntfs', 'ntfs3']);

/** Decode octal escapes used in /proc/mounts (e.g. \040 for space). */
function unescapeMount(s: string): string {
  return s.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));
}

export function parseMounts(text: string): Mount[] {
  const seen = new Set<string>();
  const out: Mount[] = [];
  for (const line of text.split('\n')) {
    const [device, mp, fstype] = line.split(' ');
    if (!device || !mp || !fstype || !REAL_FS.has(fstype)) continue;
    const mountpoint = unescapeMount(mp);
    if (mountpoint.startsWith('/snap/') || mountpoint.startsWith('/boot/efi')) continue;
    // Same device mounted twice (bind mounts): report it once.
    if (seen.has(device)) continue;
    seen.add(device);
    out.push({ device, mountpoint, fstype });
  }
  return out;
}

export function parseOsRelease(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!m) continue;
    let v = m[2]!;
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]!] = v.replace(/\\(["$`\\])/g, '$1');
  }
  return out;
}
