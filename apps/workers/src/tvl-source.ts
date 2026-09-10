import { priceFromSqrtX96, robinhoodMainnet } from "@funi/core";

export const TVL_FRESHNESS_TTL_MS=Number(process.env.UNISWAP_TVL_TTL_MS??60_000);
export type TrustedTvl={tvlUsd:number;tvlSource:string;observedAtMs:number;freshUntilMs:number;status:'fresh'};
export type TvlResult=TrustedTvl|{status:'missing'|'invalid';reason:string};
export const UNISWAP_LP_POOL_INFO_URL="https://liquidity.api.uniswap.org/lp/pool_info";

const strictTvlQuery='query StrictTvl($id: String!) { pool(id: $id) { totalValueLockedUSD tvlUsd observedAt timestamp } }',
  compatibleTvlQuery='query CompatibleTvl($id: String!) { pool(id: $id) { totalValueLockedUSD } _meta { block { number timestamp } } }';

type UniswapLpPoolInfo={
  poolReferenceIdentifier?:unknown;
  tokenAddressA?:unknown;
  tokenAddressB?:unknown;
  tokenAmountA?:unknown;
  tokenAmountB?:unknown;
  tokenDecimalsA?:unknown;
  tokenDecimalsB?:unknown;
  sqrtRatioX96?:unknown;
  token0Reserves?:unknown;
  token1Reserves?:unknown;
};

function missingOptionalTvlFields(body:any){
  const messages=Array.isArray(body?.errors)?body.errors.map((error:any)=>String(error?.message??'')):[];
  return messages.some((message:string)=>/Type `Pool` has no field `(tvlUsd|observedAt|timestamp)`/.test(message));
}

function observedAtMsFrom(value:unknown){
  if(typeof value==='number')return value<10_000_000_000?value*1000:value;
  const parsed=Date.parse(String(value));
  return Number.isFinite(parsed)?parsed:NaN;
}

async function postTvlQuery(endpoint:string,query:string,pool:string){
  const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query,variables:{id:pool.toLowerCase()}})});
  return {response,body:await response.json() as any};
}

function finitePositive(value:number){return Number.isFinite(value)&&value>0;}
function normalizedAddress(value:unknown){return typeof value==="string"&&/^0x[a-fA-F0-9]{40}$/.test(value)?value.toLowerCase():null;}
function amountFrom(value:unknown,decimals:unknown){
  const d=Number(decimals);
  if(!Number.isInteger(d)||d<0||d>255)return NaN;
  const raw=String(value??"").trim();
  if(!raw)return NaN;
  if(/^-?\d+\.\d+$/.test(raw))return Number(raw);
  if(!/^\d+$/.test(raw))return NaN;
  return Number(raw)/10**d;
}
function firstFinite(...values:number[]){
  return values.find(Number.isFinite)??NaN;
}
function sideAmount(pool:UniswapLpPoolInfo,side:"A"|"B"){
  return side==="A"
    ? firstFinite(amountFrom(pool.token0Reserves,pool.tokenDecimalsA),amountFrom(pool.tokenAmountA,pool.tokenDecimalsA))
    : firstFinite(amountFrom(pool.token1Reserves,pool.tokenDecimalsB),amountFrom(pool.tokenAmountB,pool.tokenDecimalsB));
}
function configuredNativeUsd(){
  const value=Number(process.env.GAS_USD_PER_NATIVE);
  return finitePositive(value)?value:null;
}
function deriveUsdTvlFromPoolInfo(pool:UniswapLpPoolInfo){
  const tokenA=normalizedAddress(pool.tokenAddressA),tokenB=normalizedAddress(pool.tokenAddressB);
  if(!tokenA||!tokenB)return null;
  const decimalsA=Number(pool.tokenDecimalsA),decimalsB=Number(pool.tokenDecimalsB);
  if(!Number.isInteger(decimalsA)||!Number.isInteger(decimalsB))return null;
  const amountA=sideAmount(pool,"A"),amountB=sideAmount(pool,"B");
  if(!Number.isFinite(amountA)||!Number.isFinite(amountB))return null;
  const usdg=robinhoodMainnet.assets.USDG.toLowerCase(),weth=robinhoodMainnet.assets.WETH.toLowerCase(),nativeUsd=configuredNativeUsd();
  const sqrt=typeof pool.sqrtRatioX96==="string"&&/^\d+$/.test(pool.sqrtRatioX96)?BigInt(pool.sqrtRatioX96):null,
    token1PerToken0=sqrt&&sqrt>0n?priceFromSqrtX96(sqrt,decimalsA,decimalsB):null;
  const usdA=tokenA===usdg?1:tokenA===weth&&nativeUsd?nativeUsd:tokenB===usdg&&finitePositive(token1PerToken0??NaN)?token1PerToken0!:tokenB===weth&&nativeUsd&&finitePositive(token1PerToken0??NaN)?token1PerToken0!*nativeUsd:null,
    usdB=tokenB===usdg?1:tokenB===weth&&nativeUsd?nativeUsd:tokenA===usdg&&finitePositive(token1PerToken0??NaN)?1/token1PerToken0!:tokenA===weth&&nativeUsd&&finitePositive(token1PerToken0??NaN)?nativeUsd/token1PerToken0!:null;
  if(usdA===null||usdB===null)return null;
  const tvlUsd=amountA*usdA+amountB*usdB;
  return finitePositive(tvlUsd)?tvlUsd:null;
}

export async function configuredUniswapLpApiTvl(protocol:"v3"|"v4",pool:string,fetcher:typeof fetch=fetch):Promise<TvlResult>{
  const apiKey=process.env.UNISWAP_LP_API_KEY?.trim();
  if(!apiKey)return {status:"missing",reason:"UNISWAP_LP_API_KEY_NOT_CONFIGURED"};
  if(!Number.isSafeInteger(TVL_FRESHNESS_TTL_MS)||TVL_FRESHNESS_TTL_MS<1)return {status:"invalid",reason:"UNISWAP_TVL_TTL_MS_INVALID"};
  const endpoint=process.env.UNISWAP_LP_API_URL?.trim()||UNISWAP_LP_POOL_INFO_URL;
  try{
    const response=await fetcher(endpoint,{method:"POST",headers:{"content-type":"application/json",accept:"application/json","x-api-key":apiKey},body:JSON.stringify({protocol:protocol.toUpperCase(),chainId:robinhoodMainnet.chainId,poolReferences:[{referenceIdentifier:pool.toLowerCase()}]})});
    const body=await response.json() as any;
    const poolInfo=(Array.isArray(body?.pools)?body.pools:[]).find((item:UniswapLpPoolInfo)=>String(item?.poolReferenceIdentifier??"").toLowerCase()===pool.toLowerCase()) as UniswapLpPoolInfo|undefined;
    const tvlUsd=poolInfo?deriveUsdTvlFromPoolInfo(poolInfo):null,observedAtMs=Date.now();
    if(!response.ok||!poolInfo||!finitePositive(tvlUsd??NaN))return {status:"invalid",reason:"UNISWAP_LP_POOL_INFO_RESPONSE_INVALID"};
    return {tvlUsd:tvlUsd!,tvlSource:`uniswap-lp-api:${new URL(endpoint).host}:${protocol}:derived-reserves`,observedAtMs,freshUntilMs:observedAtMs+TVL_FRESHNESS_TTL_MS,status:"fresh"};
  }catch(error){return {status:"missing",reason:`UNISWAP_LP_POOL_INFO_UNAVAILABLE:${error instanceof Error?error.message:"unknown"}`};}
}

export async function configuredUniswapTvl(protocol:'v3'|'v4',pool:string):Promise<TvlResult>{
 const lpApi=await configuredUniswapLpApiTvl(protocol,pool);
 if(lpApi.status==="fresh"||process.env.UNISWAP_LP_API_KEY)return lpApi;
 const endpoint=process.env.UNISWAP_TVL_GRAPHQL_URL;
 if(!endpoint)return {status:'missing',reason:'UNISWAP_TVL_GRAPHQL_URL_NOT_CONFIGURED'};
 if(!Number.isSafeInteger(TVL_FRESHNESS_TTL_MS)||TVL_FRESHNESS_TTL_MS<1)return {status:'invalid',reason:'UNISWAP_TVL_TTL_MS_INVALID'};
 try{
  let {response,body}=await postTvlQuery(endpoint,strictTvlQuery,pool);
  if(response.ok&&missingOptionalTvlFields(body))({response,body}=await postTvlQuery(endpoint,compatibleTvlQuery,pool));
  const poolRow=body?.data?.pool,
    metaBlock=body?.data?._meta?.block,
    tvlUsd=Number(poolRow?.totalValueLockedUSD??poolRow?.tvlUsd),
    observedAtMs=observedAtMsFrom(poolRow?.observedAt??poolRow?.timestamp??metaBlock?.timestamp??Date.now());
  if(!response.ok||!Number.isFinite(tvlUsd)||tvlUsd<=0||!Number.isFinite(observedAtMs)||observedAtMs<=0)return {status:'invalid',reason:'UNISWAP_TVL_RESPONSE_INVALID'};
  const freshUntilMs=observedAtMs+TVL_FRESHNESS_TTL_MS;
  if(freshUntilMs<=Date.now())return {status:'missing',reason:'UNISWAP_TVL_STALE'};
  return {tvlUsd,tvlSource:`uniswap-graphql:${new URL(endpoint).host}:${protocol}`,observedAtMs,freshUntilMs,status:'fresh'};
 }catch(error){return {status:'missing',reason:`UNISWAP_TVL_UNAVAILABLE:${error instanceof Error?error.message:'unknown'}`};}
}
