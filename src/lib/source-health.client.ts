'use client';

const STORAGE_KEY = 'joyflix:source-health:v2';
const MAX_SOURCES = 120;
const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000;

type SourceHealth = {
  successes: number;
  failures: number;
  stalls: number;
  avgStartupMs: number;
  startupSamples: number;
  lastSuccessAt: number;
  lastFailureAt: number;
  cooldownUntil: number;
};

type HealthStore = Record<string, SourceHealth>;

const EMPTY_HEALTH: SourceHealth = {
  successes: 0,
  failures: 0,
  stalls: 0,
  avgStartupMs: 0,
  startupSamples: 0,
  lastSuccessAt: 0,
  lastFailureAt: 0,
  cooldownUntil: 0,
};

function loadStore(): HealthStore {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveStore(store: HealthStore) {
  if (typeof window === 'undefined') return;
  try {
    const entries = Object.entries(store)
      .sort(([, a], [, b]) =>
        Math.max(b.lastSuccessAt, b.lastFailureAt) -
        Math.max(a.lastSuccessAt, a.lastFailureAt)
      )
      .slice(0, MAX_SOURCES);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // 健康度属于可选优化，存储失败不能影响播放。
  }
}

function getHealth(store: HealthStore, source: string): SourceHealth {
  return { ...EMPTY_HEALTH, ...(store[source] || {}) };
}

function scoreHealth(health: SourceHealth, now: number): number {
  if (health.cooldownUntil > now) return -10000;

  let score = 0;
  score += Math.min(health.successes, 20) * 2.5;
  score -= Math.min(health.failures, 10) * 8;
  score -= Math.min(health.stalls, 20) * 2.5;

  if (health.lastSuccessAt && now - health.lastSuccessAt < 24 * 60 * 60 * 1000) {
    score += 12;
  }
  if (health.lastFailureAt && now - health.lastFailureAt < 30 * 60 * 1000) {
    score -= 18;
  }

  if (health.avgStartupMs > 0) {
    if (health.avgStartupMs < 1500) score += 15;
    else if (health.avgStartupMs < 3000) score += 8;
    else if (health.avgStartupMs > 6000) score -= 12;
  }

  return score;
}

export function isSourceCoolingDown(source: string): boolean {
  const health = getHealth(loadStore(), source);
  return health.cooldownUntil > Date.now();
}

export function getSourceHealthScore(source: string): number {
  const store = loadStore();
  return scoreHealth(getHealth(store, source), Date.now());
}

export function rankSourcesByHealth<T extends { source: string }>(sources: T[]): T[] {
  // 排序前只读取/解析一次 localStorage，避免比较器 O(n log n) 次重复 JSON.parse。
  const store = loadStore();
  const now = Date.now();
  const scores = new Map<string, number>();

  for (const source of sources) {
    if (!scores.has(source.source)) {
      scores.set(source.source, scoreHealth(getHealth(store, source.source), now));
    }
  }

  return [...sources].sort(
    (a, b) => (scores.get(b.source) || 0) - (scores.get(a.source) || 0)
  );
}

export function recordSourceSuccess(source: string, startupMs?: number) {
  if (!source) return;
  const store = loadStore();
  const health = getHealth(store, source);
  health.successes = Math.min(health.successes + 1, 100);
  health.failures = Math.max(0, health.failures - 1);
  health.stalls = Math.max(0, health.stalls - 1);
  health.lastSuccessAt = Date.now();
  health.cooldownUntil = 0;

  if (startupMs && Number.isFinite(startupMs) && startupMs > 0 && startupMs < 30000) {
    health.avgStartupMs = health.startupSamples
      ? health.avgStartupMs * 0.75 + startupMs * 0.25
      : startupMs;
    health.startupSamples = Math.min(health.startupSamples + 1, 100);
  }

  store[source] = health;
  saveStore(store);
}

export function recordSourceStall(source: string) {
  if (!source) return;
  const store = loadStore();
  const health = getHealth(store, source);
  health.stalls = Math.min(health.stalls + 1, 100);
  store[source] = health;
  saveStore(store);
}

export function recordSourceFailure(
  source: string,
  cooldownMs = DEFAULT_COOLDOWN_MS
) {
  if (!source) return;
  const store = loadStore();
  const health = getHealth(store, source);
  health.failures = Math.min(health.failures + 1, 100);
  health.lastFailureAt = Date.now();
  health.cooldownUntil = Math.max(health.cooldownUntil, Date.now() + cooldownMs);
  store[source] = health;
  saveStore(store);
}
