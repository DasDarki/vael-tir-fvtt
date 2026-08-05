export const MODULE_ID = "vael-tir-fvtt";
export const FLAG_KEY = "erdgebunden";

/** World-setting key holding the shared party pool state (money, items, log). */
export const PARTY_POOL_SETTING = "partyPool";

/** socketlib handler names for party-pool operations. */
export const POOL_SOCKET = {
  depositMoney: "pool-deposit-money",
  depositItem: "pool-deposit-item",
  withdrawMoney: "pool-withdraw-money",
  withdrawItem: "pool-withdraw-item",
  transferMoney: "pool-transfer-money",
  transferItem: "pool-transfer-item",
} as const;

export let socket: any;

export function setSocket(newSocket: any) {
  socket = newSocket;
}
