/**
 * The configured Uniswap indexer is authoritative for USD TVL. This module
 * deliberately has no price/reserve fallback: the TVL must come from GraphQL.
 */
export const TVL_FRESHNESS_TTL_MS=Number(process.env.UNISWAP_TVL_TTL_MS??60_000);
export type TrustedTvl={tvlUsd:number;tvlSource:string;observedAtMs:number;freshUntilMs:number;status:'fresh'};
export type TvlResult=TrustedTvl|{status:'missing'|'invalid';reason:string};

const strictTvlQuery='query StrictTvl($id: String!) { pool(id: $id) { totalValueLockedUSD tvlUsd observedAt timestamp } }',
  compatibleTvlQuery='query CompatibleTvl($id: String!) { pool(id: $id) { totalValueLockedUSD } _meta { block { number timestamp } } }';

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

export async function configuredUniswapTvl(protocol:'v3'|'v4',pool:string):Promise<TvlResult>{
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
