import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface CacheData {
  version: number;
  providerKey: string;
  modelId: string;
  allowedUsers: string[];
}

const CACHE_FILE = join(process.cwd(), "data", "cache.json");

function ensureDir(): void {
  const dir = join(process.cwd(), "data");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function loadCache(): CacheData | null {
  try {
    ensureDir();
    if (!existsSync(CACHE_FILE)) return null;
    const raw = readFileSync(CACHE_FILE, "utf-8");
    const data = JSON.parse(raw) as CacheData;
    if (
      typeof data.version === "number" &&
      typeof data.providerKey === "string" &&
      typeof data.modelId === "string" &&
      Array.isArray(data.allowedUsers)
    ) {
      return data;
    }
    return null;
  } catch {
    return null;
  }
}

export function saveCache(providerKey: string, modelId: string, allowedUsers: string[]): void {
  try {
    ensureDir();
    const data: CacheData = { version: 1, providerKey, modelId, allowedUsers };
    writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    console.error("Failed to save cache:", err);
  }
}
