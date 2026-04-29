import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { SwarmConfigSchema, type SwarmConfig } from "./schema.js";

export async function loadConfig(cwd: string): Promise<SwarmConfig> {
  const path = resolve(cwd, "swarm.yaml");
  const raw = await readFile(path, "utf8");
  const parsed = parseYaml(raw);
  return SwarmConfigSchema.parse(parsed);
}
