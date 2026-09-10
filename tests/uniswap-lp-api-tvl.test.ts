import { afterEach, describe, expect, it } from "vitest";
import { robinhoodMainnet } from "@funi/core";
import { configuredUniswapLpApiTvl, UNISWAP_LP_POOL_INFO_URL } from "../apps/workers/src/tvl-source.js";

const envSnapshot = { ...process.env };
const q96 = (2n ** 96n).toString();
const token = "0x00000000000000000000000000000000000000aa";
const pool = `0x${"1".repeat(64)}`;

afterEach(() => {
  process.env = { ...envSnapshot };
});

describe("Uniswap LP API TVL source", () => {
  it("requires the official LP API key before fetching", async () => {
    delete process.env.UNISWAP_LP_API_KEY;
    await expect(configuredUniswapLpApiTvl("v4", pool, async () => {
      throw new Error("should not fetch");
    })).resolves.toEqual({ status: "missing", reason: "UNISWAP_LP_API_KEY_NOT_CONFIGURED" });
  });

  it("posts poolReferences to /lp/pool_info and derives USDG-pair TVL from returned reserves", async () => {
    process.env.UNISWAP_LP_API_KEY = "key";
    process.env.UNISWAP_TVL_TTL_MS = "300000";
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const result = await configuredUniswapLpApiTvl("v4", pool, async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return Response.json({
        requestId: "req",
        pools: [{
          poolReferenceIdentifier: pool,
          tokenAddressA: robinhoodMainnet.assets.USDG,
          tokenAddressB: token,
          tokenDecimalsA: 6,
          tokenDecimalsB: 6,
          token0Reserves: "100000000",
          token1Reserves: "50000000",
          sqrtRatioX96: q96,
        }],
      });
    });
    expect(result).toMatchObject({ status: "fresh", tvlUsd: 150 });
    expect(calls[0]!.url).toBe(UNISWAP_LP_POOL_INFO_URL);
    expect(calls[0]!.init.headers).toMatchObject({ "x-api-key": "key" });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      protocol: "V4",
      chainId: 4663,
      poolReferences: [{ poolReferenceIdentifier: pool.toLowerCase() }],
    });
  });

  it("can value WETH-pair pools when GAS_USD_PER_NATIVE is configured", async () => {
    process.env.UNISWAP_LP_API_KEY = "key";
    process.env.GAS_USD_PER_NATIVE = "4000";
    const result = await configuredUniswapLpApiTvl("v4", pool, async () => Response.json({
      pools: [{
        poolReferenceIdentifier: pool,
        tokenAddressA: robinhoodMainnet.assets.WETH,
        tokenAddressB: token,
        tokenDecimalsA: 18,
        tokenDecimalsB: 18,
        token0Reserves: "1000000000000000000",
        token1Reserves: "2000000000000000000",
        sqrtRatioX96: q96,
      }],
    }));
    expect(result).toMatchObject({ status: "fresh", tvlUsd: 12_000 });
  });

  it("fails closed when pool_info cannot provide enough valuation evidence", async () => {
    process.env.UNISWAP_LP_API_KEY = "key";
    const result = await configuredUniswapLpApiTvl("v4", pool, async () => Response.json({
      pools: [{
        poolReferenceIdentifier: pool,
        tokenAddressA: "0x00000000000000000000000000000000000000bb",
        tokenAddressB: token,
        tokenDecimalsA: 18,
        tokenDecimalsB: 18,
        token0Reserves: "1000000000000000000",
        token1Reserves: "2000000000000000000",
        sqrtRatioX96: q96,
      }],
    }));
    expect(result).toEqual({ status: "invalid", reason: "UNISWAP_LP_POOL_INFO_RESPONSE_INVALID" });
  });
});
