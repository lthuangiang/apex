export interface PerplConfig {
  apiKey: string;
  apiKeySecret: string; // hex Ed25519 private key
  chainId?: number;
  baseUrl?: string;
  wsUrl?: string;
}

export interface PerplMarket {
  id: number;
  symbol: string;
  name: string;
  priceDecimals: number;
  sizeDecimals: number;
  minPostingAmount: number;
  initialMargin: number; // hundredths (1000 = 10x max lev)
  makerFee: number;
  takerFee: number;
  isOpen: boolean;
  state: PerplMarketState;
}

export interface PerplMarketState {
  orl: number; // oracle (scaled)
  mrk: number; // mark
  lst: number; // last trade
  mid: number;
  bid: number;
  ask: number;
  dv: number;
}

export interface PerplAccount {
  instanceId: number;
  accountId: number;
  frozen: boolean;
  lastForwardedRq: number;
  balance: string;
  lockedBalance: string;
}

export enum PerplOrderType {
  OpenLong = 1,
  OpenShort = 2,
  CloseLong = 3,
  CloseShort = 4,
  Cancel = 5,
}

export enum PerplOrderFlags {
  GoodTillCancel = 0,
  PostOnly = 1,
  FillOrKill = 2,
  ImmediateOrCancel = 4,
}

export enum PerplPositionType {
  Long = 1,
  Short = 2,
}

export interface PerplOrderRequest {
  mt: 22;
  rq: number;
  mkt: number;
  acc: number;
  t: PerplOrderType;
  p: number;   // scaled price (0 = market)
  s: number;   // scaled size
  fl: number;  // flags
  lv: number;  // leverage hundredths
  lb: number;  // last valid block
  oid?: number; // for cancel
}

export interface PerplPosition {
  mkt: number;
  acc: number;
  pid: number;
  sd: PerplPositionType;
  c: string;   // collateral (Amount string)
  ep: number;  // entry price (scaled)
  s: number;   // size (scaled)
  lv: number;
  st: number;  // status
}

export interface PerplOrder {
  rq: number;
  mkt: number;
  acc: number;
  oid: number;
  t: PerplOrderType;
  st: number;
  p: number;
  os: number;
  fs: number;
  fl: number;
}

export interface PerplContextResponse {
  chain: { id: number; name: string };
  instances: PerplInstance[];
  tokens: PerplToken[];
  markets: PerplMarketRaw[];
}

export interface PerplInstance {
  id: number;
  exchange: string;
  block_number: number;
}

export interface PerplToken {
  id: number;
  symbol: string;
  decimals: number;
  display_precision: number;
}

export interface PerplMarketRaw {
  id: number;
  symbol: string;
  name: string;
  config: {
    is_open: boolean;
    price_decimals: number;
    size_decimals: number;
    min_posting_amount: string;
    initial_margin: number;
    maker_fee: number;
    taker_fee: number;
  };
  state: {
    orl: number;
    mrk: number;
    lst: number;
    mid: number;
    bid: number;
    ask: number;
    dv: number;
  };
}
