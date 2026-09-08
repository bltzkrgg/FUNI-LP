import type { SqliteLedgerRepository } from "@funi/ledger";
import type { RuntimeEnv } from "../../cli/src/runtime.js";

type ValueType = "boolean" | "number" | "integer";
type RuntimeConfigKey =
  | "MAX_SLIPPAGE_BPS"
  | "MAX_GAS_COST_USD"
  | "MAX_LIFECYCLE_GAS_USD"
  | "V4_MAX_EXECUTION_STATIC_FEE_PIPS"
  | "GAS_USD_PER_NATIVE"
  | "EXECUTION_ENABLED"
  | "DRY_RUN"
  | "EMERGENCY_PAUSE";

type RuntimeConfigSpec = {
  alias: string;
  key: RuntimeConfigKey;
  label: string;
  type: ValueType;
  min?: number;
  max?: number;
  integer?: boolean;
};

export const TELEGRAM_RUNTIME_CONFIG_SPECS: RuntimeConfigSpec[] = [
  { alias: "slippage", key: "MAX_SLIPPAGE_BPS", label: "Slippage", type: "integer", min: 0, max: 10_000, integer: true },
  { alias: "gas_cap", key: "MAX_GAS_COST_USD", label: "Per-tx gas cap", type: "number", min: 0.01, max: 2 },
  { alias: "lifecycle_gas", key: "MAX_LIFECYCLE_GAS_USD", label: "Lifecycle gas cap", type: "number", min: 0.01, max: 1 },
  { alias: "max_fee", key: "V4_MAX_EXECUTION_STATIC_FEE_PIPS", label: "Max v4 pool fee", type: "integer", min: 0, max: 1_000_000, integer: true },
  { alias: "native_usd", key: "GAS_USD_PER_NATIVE", label: "Native USD price", type: "number", min: 0.01, max: 1_000_000 },
];

const specByAlias = new Map(TELEGRAM_RUNTIME_CONFIG_SPECS.map((spec) => [spec.alias, spec]));
const specByKey = new Map(TELEGRAM_RUNTIME_CONFIG_SPECS.map((spec) => [spec.key, spec]));

export function runtimeConfigHelp() {
  return [
    "Runtime config:",
    "/config - show current runtime values",
    "/config slippage 100",
    "/config gas_cap 2",
    "/config lifecycle_gas 1",
    "/config max_fee 100000",
    "/config native_usd 5000",
    "/config dry_run true - safe mode",
    "/config dry_run false - live mode, requires button confirm",
  ].join("\n");
}

function formatValue(key: RuntimeConfigKey, value: unknown) {
  if (key === "V4_MAX_EXECUTION_STATIC_FEE_PIPS") return `${String(value)} pips (${(Number(value) / 10_000).toFixed(4)}%)`;
  if (key === "MAX_SLIPPAGE_BPS") return `${String(value)} bps (${(Number(value) / 100).toFixed(2)}%)`;
  if (key === "MAX_GAS_COST_USD" || key === "MAX_LIFECYCLE_GAS_USD" || key === "GAS_USD_PER_NATIVE") return `$${Number(value)}`;
  return String(value);
}

export function formatRuntimeConfig(env: RuntimeEnv, repo: SqliteLedgerRepository) {
  const overrides = new Set(repo.runtimeConfigOverrides().map((row) => row.key));
  return [
    "Runtime config",
    `Mode: execution ${env.EXECUTION_ENABLED ? "enabled" : "disabled"} · dry_run ${env.DRY_RUN} · emergency ${env.EMERGENCY_PAUSE}`,
    "",
    ...TELEGRAM_RUNTIME_CONFIG_SPECS.map((spec) => {
      const marker = overrides.has(spec.key) ? "telegram" : ".env/default";
      return `${spec.alias}: ${formatValue(spec.key, env[spec.key as keyof RuntimeEnv])} (${marker})`;
    }),
  ].join("\n");
}

export function applyRuntimeConfigOverrides(repo: SqliteLedgerRepository, env: RuntimeEnv) {
  const applied: string[] = [];
  for (const row of repo.runtimeConfigOverrides()) {
    const key = row.key as RuntimeConfigKey;
    if (!specByKey.has(key) && !["EXECUTION_ENABLED", "DRY_RUN", "EMERGENCY_PAUSE"].includes(key)) continue;
    const value = row.value_type === "boolean" ? String(row.value).toLowerCase() === "true" : Number(row.value);
    if (typeof value === "number" && !Number.isFinite(value)) continue;
    setRuntimeConfigValue(env, key, value);
    applied.push(key);
  }
  return applied;
}

export function parseRuntimeConfigCommand(input: string) {
  const [alias, rawValue] = input.trim().split(/\s+/, 2);
  if (!alias) return { type: "show" as const };
  if (alias !== "dry_run") {
    const spec = specByAlias.get(alias);
    if (!spec || rawValue === undefined) return { type: "help" as const };
    const value = Number(rawValue);
    if (
      !Number.isFinite(value) ||
      (spec.integer && !Number.isSafeInteger(value)) ||
      (spec.min !== undefined && value < spec.min) ||
      (spec.max !== undefined && value > spec.max)
    )
      return { type: "invalid" as const, message: `${spec.alias} must be ${spec.integer ? "an integer" : "a number"} from ${spec.min} to ${spec.max}.` };
    return { type: "set" as const, spec, value };
  }
  const normalized = String(rawValue ?? "").trim().toLowerCase();
  if (!["true", "false"].includes(normalized)) return { type: "invalid" as const, message: "dry_run must be true or false." };
  return { type: "dryRun" as const, dryRun: normalized === "true" };
}

export function persistRuntimeConfigValue(repo: SqliteLedgerRepository, actor: string, spec: RuntimeConfigSpec, value: number) {
  repo.setRuntimeConfigOverride({ key: spec.key, value: String(value), valueType: spec.type, actor });
}

export function applyRuntimeConfigValue(env: RuntimeEnv, spec: RuntimeConfigSpec, value: number) {
  setRuntimeConfigValue(env, spec.key, value);
}

export function applyDryRunMode(repo: SqliteLedgerRepository, env: RuntimeEnv, actor: string, dryRun: boolean) {
  const values = dryRun
    ? { EXECUTION_ENABLED: false, DRY_RUN: true, EMERGENCY_PAUSE: true }
    : { EXECUTION_ENABLED: true, DRY_RUN: false, EMERGENCY_PAUSE: false };
  for (const [key, value] of Object.entries(values) as Array<[RuntimeConfigKey, boolean]>) {
    repo.setRuntimeConfigOverride({ key, value: String(value), valueType: "boolean", actor });
    setRuntimeConfigValue(env, key, value);
  }
  const prior = repo.safetyState() ?? {};
  repo.persistSafetyState({
    ...prior,
    chainId: env.RH_CHAIN_ID,
    ...values,
    liveCanaryEnabled: env.LIVE_CANARY_ENABLED,
    maxPositionValueUsd: env.MAX_POSITION_VALUE_USD,
    maxApprovalValueUsd: env.MAX_APPROVAL_VALUE_USD,
    maxGasCostUsd: env.MAX_GAS_COST_USD,
    maxSlippageBps: env.MAX_SLIPPAGE_BPS,
    effectiveEmergencyPause: values.EMERGENCY_PAUSE || prior.manualPause === true,
    actor,
    reason: dryRun ? "telegram safe mode" : "telegram live mode confirmation",
    activationAt: dryRun ? undefined : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

function setRuntimeConfigValue(env: RuntimeEnv, key: RuntimeConfigKey, value: boolean | number) {
  (env as unknown as Record<string, unknown>)[key] = value;
  process.env[key] = String(value);
}
