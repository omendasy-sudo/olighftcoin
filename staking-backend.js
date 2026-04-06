// ═══════════════════════════════════════════════════════════════
//  OLIGHFT SMART COIN — Soroban Staking Backend
//  Connects card pages to the deployed card_staking contract
//  on Stellar Testnet via Soroban RPC.
// ═══════════════════════════════════════════════════════════════

const STAKING_BACKEND = (function() {
  'use strict';

  // ── Contract & Network Config ──────────────────────────────
  const CARD_STAKING_CONTRACT = 'CANTB5ENAFHLN2CWRFA5JFTXNXIR2DZZF4RXY6644BOSWCHQOWPVDB3V';
  const TOKEN_CONTRACT        = 'CA5NW2ZJISLPTRRPEFY7XIKSB5CZ5XF2PIARJL2F37H7EPRAXXD34W6J';
  const SOROBAN_RPC_URL       = 'https://soroban-testnet.stellar.org';
  const HORIZON_URL           = 'https://horizon-testnet.stellar.org';
  const NETWORK_PASSPHRASE    = 'Test SDF Network ; September 2015';
  const DECIMALS              = 7;
  const STROOPS               = 10_000_000; // 10^7

  // Card tier enum values (must match contract CardTier)
  const TIER_MAP = {
    'Visa':       0,
    'Gold':       1,
    'Platinum':   2,
    'Black':      3,
    'Amex':       4,
    'Mastercard': 5
  };

  // ── SDK References ─────────────────────────────────────────
  // stellar-sdk v11.3.0 loaded via CDN exposes global StellarSdk
  let rpcServer = null;
  let horizonServer = null;

  function getRpc() {
    if (!rpcServer) {
      rpcServer = new StellarSdk.SorobanRpc.Server(SOROBAN_RPC_URL);
    }
    return rpcServer;
  }

  function getHorizon() {
    if (!horizonServer) {
      horizonServer = new StellarSdk.Horizon.Server(HORIZON_URL);
    }
    return horizonServer;
  }

  // ── Wallet helpers ─────────────────────────────────────────

  function getWalletKeypair() {
    const encoded = localStorage.getItem('cw_secret');
    if (!encoded) return null;
    try {
      const secret = atob(encoded);
      return StellarSdk.Keypair.fromSecret(secret);
    } catch(e) {
      console.error('Failed to decode wallet keypair:', e);
      return null;
    }
  }

  function getPublicKey() {
    try {
      const user = JSON.parse(localStorage.getItem('cw_user') || 'null');
      return user && user.addr ? user.addr : null;
    } catch(e) {
      return null;
    }
  }

  // ── Soroban transaction builder ────────────────────────────

  async function buildAndSubmitTx(contractId, method, params) {
    const kp = getWalletKeypair();
    if (!kp) throw new Error('Wallet not connected. Please log in first.');

    const rpc = getRpc();
    const account = await rpc.getAccount(kp.publicKey());

    const contract = new StellarSdk.Contract(contractId);
    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: '100000',
      networkPassphrase: NETWORK_PASSPHRASE,
    })
    .addOperation(contract.call(method, ...params))
    .setTimeout(120)
    .build();

    // Simulate first
    const simResult = await rpc.simulateTransaction(tx);
    if (StellarSdk.SorobanRpc.Api.isSimulationError(simResult)) {
      const errMsg = simResult.error || 'Simulation failed';
      throw new Error('Contract error: ' + errMsg);
    }

    // Assemble with simulation results (adds auth + resource info)
    // assembleTransaction returns a Transaction (not TransactionBuilder) in sdk v11
    const preparedTx = StellarSdk.SorobanRpc.assembleTransaction(tx, simResult).build();
    preparedTx.sign(kp);

    // Submit
    const sendResult = await rpc.sendTransaction(preparedTx);
    if (sendResult.status === 'ERROR') {
      throw new Error('Transaction submission failed: ' + (sendResult.errorResult || sendResult.status));
    }

    // Poll for completion
    const hash = sendResult.hash;
    let getResult;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 2000));
      getResult = await rpc.getTransaction(hash);
      if (getResult.status !== 'NOT_FOUND') break;
    }

    if (!getResult || getResult.status === 'NOT_FOUND') {
      throw new Error('Transaction not confirmed after 60 seconds');
    }
    if (getResult.status === 'FAILED') {
      throw new Error('Transaction failed on-chain');
    }

    // Attach tx hash so callers can access it as result.hash
    getResult.hash = hash;
    return getResult;
  }

  // ── Read-only contract queries (no signing needed) ─────────

  async function queryContract(method, params) {
    const pubKey = getPublicKey();
    const sourceForSim = pubKey || 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

    const rpc = getRpc();
    const account = await rpc.getAccount(sourceForSim);

    const contract = new StellarSdk.Contract(CARD_STAKING_CONTRACT);
    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: '100',
      networkPassphrase: NETWORK_PASSPHRASE,
    })
    .addOperation(contract.call(method, ...params))
    .setTimeout(30)
    .build();

    const simResult = await rpc.simulateTransaction(tx);
    if (StellarSdk.SorobanRpc.Api.isSimulationError(simResult)) {
      throw new Error('Query failed: ' + (simResult.error || 'unknown'));
    }

    return simResult.result;
  }

  // ── Helper: build ScVal parameters ─────────────────────────

  function addressVal(addr) {
    return new StellarSdk.Address(addr).toScVal();
  }

  function tierVal(tierName) {
    const num = TIER_MAP[tierName];
    if (num === undefined) throw new Error('Unknown card tier: ' + tierName);
    // CardTier is a u32 enum variant
    return StellarSdk.xdr.ScVal.scvU32(num);
  }

  function i128Val(amount) {
    return StellarSdk.nativeToScVal(amount, { type: 'i128' });
  }

  function u32Val(num) {
    return StellarSdk.xdr.ScVal.scvU32(num);
  }

  // ── Convert OLIGHFT to stroops (7 decimals) ────────────────
  function toStroops(amount) {
    return BigInt(Math.round(amount * STROOPS));
  }

  function fromStroops(stroops) {
    return Number(stroops) / STROOPS;
  }

  // ── Public API ─────────────────────────────────────────────

  /**
   * Activate a new card stake on-chain
   * @param {string} tierName - 'Visa','Gold','Platinum','Black','Amex','Mastercard'
   * @param {number} amountOLIGHFT - Amount in OLIGHFT (will be converted to stroops)
   * @returns {Promise<{stakeIndex: number, txHash: string}>}
   */
  async function activateStake(tierName, amountOLIGHFT) {
    const kp = getWalletKeypair();
    if (!kp) throw new Error('Wallet not connected');

    const staker = new StellarSdk.Address(kp.publicKey());
    const amount = toStroops(amountOLIGHFT);

    const result = await buildAndSubmitTx(CARD_STAKING_CONTRACT, 'activate_stake', [
      staker.toScVal(),
      tierVal(tierName),
      i128Val(amount),
    ]);

    // Parse stake_index from return value
    let stakeIndex = 0;
    if (result.returnValue) {
      stakeIndex = Number(StellarSdk.scValToNative(result.returnValue));
    }

    return { stakeIndex, txHash: result.hash || '' };
  }

  /**
   * Withdraw a completed stake from the contract
   * @param {string} tierName
   * @param {number} stakeIndex
   * @returns {Promise<{totalReturn: number, txHash: string}>}
   */
  async function withdrawStake(tierName, stakeIndex) {
    const kp = getWalletKeypair();
    if (!kp) throw new Error('Wallet not connected');

    const staker = new StellarSdk.Address(kp.publicKey());

    const result = await buildAndSubmitTx(CARD_STAKING_CONTRACT, 'withdraw_stake', [
      staker.toScVal(),
      tierVal(tierName),
      u32Val(stakeIndex),
    ]);

    let totalReturn = 0;
    if (result.returnValue) {
      totalReturn = fromStroops(StellarSdk.scValToNative(result.returnValue));
    }

    return { totalReturn, txHash: result.hash || '' };
  }

  /**
   * Restake a completed stake (compound + re-lock)
   * @param {string} tierName
   * @param {number} stakeIndex
   * @returns {Promise<{newIndex: number, txHash: string}>}
   */
  async function restake(tierName, stakeIndex) {
    const kp = getWalletKeypair();
    if (!kp) throw new Error('Wallet not connected');

    const staker = new StellarSdk.Address(kp.publicKey());

    const result = await buildAndSubmitTx(CARD_STAKING_CONTRACT, 'restake', [
      staker.toScVal(),
      tierVal(tierName),
      u32Val(stakeIndex),
    ]);

    let newIndex = 0;
    if (result.returnValue) {
      newIndex = Number(StellarSdk.scValToNative(result.returnValue));
    }

    return { newIndex, txHash: result.hash || '' };
  }

  /**
   * Claim rewards from an active stake
   * @param {string} tierName
   * @param {number} stakeIndex
   * @returns {Promise<{rewards: number, txHash: string}>}
   */
  async function claimRewards(tierName, stakeIndex) {
    const kp = getWalletKeypair();
    if (!kp) throw new Error('Wallet not connected');

    const staker = new StellarSdk.Address(kp.publicKey());

    const result = await buildAndSubmitTx(CARD_STAKING_CONTRACT, 'claim_rewards', [
      staker.toScVal(),
      tierVal(tierName),
      u32Val(stakeIndex),
    ]);

    let rewards = 0;
    if (result.returnValue) {
      rewards = fromStroops(StellarSdk.scValToNative(result.returnValue));
    }

    return { rewards, txHash: result.hash || '' };
  }

  /**
   * Register a sponsor for the current user
   * @param {string} sponsorPublicKey - Stellar public key of sponsor
   */
  async function registerSponsor(sponsorPublicKey) {
    const kp = getWalletKeypair();
    if (!kp) throw new Error('Wallet not connected');

    const user = new StellarSdk.Address(kp.publicKey());
    const sponsor = new StellarSdk.Address(sponsorPublicKey);

    return await buildAndSubmitTx(CARD_STAKING_CONTRACT, 'register_sponsor', [
      user.toScVal(),
      sponsor.toScVal(),
    ]);
  }

  // ── Read-only queries ──────────────────────────────────────

  /**
   * Get all stakes for the current user on a card tier
   * @param {string} tierName
   * @returns {Promise<Array<{amount, startLedger, endLedger, lockDays, dailyReward, accrued, lastClaim, active}>>}
   */
  async function getStakes(tierName) {
    const pubKey = getPublicKey();
    if (!pubKey) return [];

    try {
      const result = await queryContract('get_stakes', [
        addressVal(pubKey),
        tierVal(tierName),
      ]);

      if (!result) return [];
      const retval = result.retval || result;
      const native = StellarSdk.scValToNative(retval);
      if (!native || !native.stakes) return [];

      return native.stakes.map(function(s, i) {
        return {
          index: i,
          amount: fromStroops(s.amount),
          startLedger: Number(s.start_ledger),
          endLedger: Number(s.end_ledger),
          lockDays: Number(s.lock_days),
          dailyReward: fromStroops(s.daily_reward),
          accrued: fromStroops(s.accrued),
          lastClaim: Number(s.last_claim),
          active: s.active
        };
      });
    } catch(e) {
      console.warn('getStakes query failed, using localStorage fallback:', e);
      return getLocalStakes(tierName);
    }
  }

  /**
   * Get active stake count for current user
   * @param {string} tierName
   */
  async function getActiveStakeCount(tierName) {
    const pubKey = getPublicKey();
    if (!pubKey) return 0;

    try {
      const result = await queryContract('active_stake_count', [
        addressVal(pubKey),
        tierVal(tierName),
      ]);
      if (!result) return 0;
      return Number(StellarSdk.scValToNative(result.retval || result));
    } catch(e) {
      console.warn('active_stake_count query failed:', e);
      return 0;
    }
  }

  /**
   * Get total staked across all users for a tier
   * @param {string} tierName
   */
  async function getTotalStaked(tierName) {
    try {
      const result = await queryContract('total_staked', [
        tierVal(tierName),
      ]);
      if (!result) return 0;
      return fromStroops(StellarSdk.scValToNative(result.retval || result));
    } catch(e) {
      console.warn('total_staked query failed:', e);
      return 0;
    }
  }

  /**
   * Get pending rewards for a specific stake
   * @param {string} tierName
   * @param {number} stakeIndex
   */
  async function getPendingRewards(tierName, stakeIndex) {
    const pubKey = getPublicKey();
    if (!pubKey) return 0;

    try {
      const result = await queryContract('pending_rewards', [
        addressVal(pubKey),
        tierVal(tierName),
        u32Val(stakeIndex),
      ]);
      if (!result) return 0;
      return fromStroops(StellarSdk.scValToNative(result.retval || result));
    } catch(e) {
      console.warn('pending_rewards query failed:', e);
      return 0;
    }
  }

  /**
   * Get card configuration for a tier
   * @param {string} tierName
   */
  async function getCardConfig(tierName) {
    try {
      const result = await queryContract('get_config', [
        tierVal(tierName),
      ]);
      if (!result) return null;
      const native = StellarSdk.scValToNative(result.retval || result);
      return {
        minStake: fromStroops(native.min_stake),
        lockDays: Number(native.lock_days),
        apyBps: Number(native.apy_bps),
        maxStakes: Number(native.max_stakes),
      };
    } catch(e) {
      console.warn('get_config query failed:', e);
      return null;
    }
  }

  // ── localStorage fallback / cache ──────────────────────────

  function getLocalStakes(tierName) {
    try {
      const all = JSON.parse(localStorage.getItem('card_stakes') || '[]');
      return all
        .filter(function(s) { return s.card === tierName && !s.withdrawn; })
        .map(function(s, i) {
          const startMs = new Date(s.date).getTime();
          const endMs = startMs + (s.period * 86400000);
          return {
            index: i,
            amount: s.paidOLIGHFT || 0,
            lockDays: s.period,
            dailyReward: s.daily || 0,
            active: Date.now() < endMs,
            startDate: s.date,
            payout: s.payout
          };
        });
    } catch(e) {
      return [];
    }
  }

  /**
   * Sync on-chain stakes to localStorage cache
   * @param {string} tierName
   */
  async function syncStakesToLocal(tierName) {
    try {
      const onChainStakes = await getStakes(tierName);
      const totalOnChain = await getTotalStaked(tierName);

      localStorage.setItem('card_stakes_onchain_' + tierName, JSON.stringify({
        stakes: onChainStakes,
        totalStaked: totalOnChain,
        syncedAt: Date.now()
      }));

      return onChainStakes;
    } catch(e) {
      console.warn('Sync failed, using cached data:', e);
      return null;
    }
  }

  // ── Status & connection check ──────────────────────────────

  function isWalletConnected() {
    return !!getWalletKeypair();
  }

  async function checkRpcHealth() {
    try {
      const rpc = getRpc();
      const health = await rpc.getHealth();
      return health.status === 'healthy';
    } catch(e) {
      return false;
    }
  }

  // ── Public interface ───────────────────────────────────────

  return {
    // Config
    CARD_STAKING_CONTRACT: CARD_STAKING_CONTRACT,
    TOKEN_CONTRACT: TOKEN_CONTRACT,
    SOROBAN_RPC_URL: SOROBAN_RPC_URL,
    NETWORK_PASSPHRASE: NETWORK_PASSPHRASE,
    TIER_MAP: TIER_MAP,
    DECIMALS: DECIMALS,
    toStroops: toStroops,
    fromStroops: fromStroops,

    // Write operations (require wallet)
    activateStake: activateStake,
    withdrawStake: withdrawStake,
    restake: restake,
    claimRewards: claimRewards,
    registerSponsor: registerSponsor,

    // Read operations
    getStakes: getStakes,
    getActiveStakeCount: getActiveStakeCount,
    getTotalStaked: getTotalStaked,
    getPendingRewards: getPendingRewards,
    getCardConfig: getCardConfig,

    // Helpers
    syncStakesToLocal: syncStakesToLocal,
    isWalletConnected: isWalletConnected,
    checkRpcHealth: checkRpcHealth,
    getPublicKey: getPublicKey,
  };
})();
