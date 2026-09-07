import type { SqliteLedgerRepository } from "@funi/ledger";
import { configuredUniswapTvl, type TvlResult } from "./tvl-source.js";

export async function fetchV4UniswapTvlForPools(poolIds: readonly string[]) {
  if (!process.env.UNISWAP_TVL_GRAPHQL_URL) return new Map<string, TvlResult>();
  const unique = [...new Set(poolIds.map((id) => id.toLowerCase()))];
  return new Map(
    await Promise.all(
      unique.map(async (id) => [id, await configuredUniswapTvl("v4", id)] as const),
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
