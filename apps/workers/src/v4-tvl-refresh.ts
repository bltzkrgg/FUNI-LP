import type { SqliteLedgerRepository } from "@funi/ledger";
import { configuredUniswapTvl, type TvlResult, type UniswapLpPoolLookup } from "./tvl-source.js";

export async function fetchV4UniswapTvlForPools(poolIds: readonly string[], lookups = new Map<string, UniswapLpPoolLookup>()) {
  if (!process.env.UNISWAP_LP_API_KEY && !process.env.UNISWAP_TVL_GRAPHQL_URL) return new Map<string, TvlResult>();
  const unique = [...new Set(poolIds.map((id) => id.toLowerCase()))];
  return new Map(
    await Promise.all(
      unique.map(async (id) => [id, await configuredUniswapTvl("v4", id, lookups.get(id))] as const),
    ),
  );
}

export function persistFetchedV4UniswapTvl(
  repo: SqliteLedgerRepository,
  tvlByPool: ReadonlyMap<string, TvlResult>,
) {
  for (const [poolId, tvl] of tvlByPool)
    repo.updateV4RegistryTvl(poolId, tvl.status === "fresh" ? tvl : { status: tvl.status });
}
