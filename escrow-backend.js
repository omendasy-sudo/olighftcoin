// ═══════════════════════════════════════════════════════════════
//  OLIGHFT SMART COIN — Soroban Escrow Backend
//  Connects the dashboard to the deployed escrow contract
//  on Stellar Testnet via Soroban RPC.
// ═══════════════════════════════════════════════════════════════

const ESCROW_BACKEND = (function() {
  'use strict';

  // ── Contract & Network Config ──────────────────────────────
  // Replace with actual deployed contract ID after `soroban contract deploy`
  const ESCROW_CONTRACT = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2QLGM5EK';
  const TOKEN_CONTRACT  = 'CA5NW2ZJISLPTRRPEFY7XIKSB5CZ5XF2PIARJL2F37H7EPRAXXD34W6J';
  const SOROBAN_RPC_URL = 'https://soroban-testnet.stellar.org';
  const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
  const DECIMALS = 7;
  const STROOPS  = 10_000_000;

  // Escrow status enum (must match contract EscrowStatus)
  const STATUS = {
    0: 'Pending',
    1: 'Funded',
    2: 'Completed',
    3: 'Disputed',
    4: 'Resolved',
    5: 'Refunded',
    6: 'Cancelled'
  };

  // ── SDK References ─────────────────────────────────────────
  let rpcServer = null;

  function getRpc() {
    if (!rpcServer) {
      rpcServer = new StellarSdk.SorobanRpc.Server(SOROBAN_RPC_URL);
    }
    return rpcServer;
  }

  // ── Wallet helpers ─────────────────────────────────────────

  function getWalletKeypair() {
    var encoded = localStorage.getItem('cw_secret');
    if (!encoded) return null;
    try {
      var secret = atob(encoded);
      return StellarSdk.Keypair.fromSecret(secret);
    } catch(e) {
      console.error('Failed to decode wallet keypair:', e);
      return null;
    }
  }

  function getPublicKey() {
    try {
      var user = JSON.parse(localStorage.getItem('cw_user') || 'null');
      return user && user.addr ? user.addr : null;
    } catch(e) {
      return null;
    }
  }

  function isWalletConnected() {
    return !!getWalletKeypair();
  }

  // ── Soroban transaction builder ────────────────────────────

  async function buildAndSubmitTx(method, params) {
    var kp = getWalletKeypair();
    if (!kp) throw new Error('Wallet not connected. Please log in first.');

    var rpc = getRpc();
    var account = await rpc.getAccount(kp.publicKey());

    var contract = new StellarSdk.Contract(ESCROW_CONTRACT);
    var tx = new StellarSdk.TransactionBuilder(account, {
      fee: '100000',
      networkPassphrase: NETWORK_PASSPHRASE,
    })
    .addOperation(contract.call(method, ...params))
    .setTimeout(120)
    .build();

    // Simulate
    var simResult = await rpc.simulateTransaction(tx);
    if (StellarSdk.SorobanRpc.Api.isSimulationError(simResult)) {
      throw new Error('Contract error: ' + (simResult.error || 'Simulation failed'));
    }

    // Assemble + sign
    var preparedTx = StellarSdk.SorobanRpc.assembleTransaction(tx, simResult).build();
    preparedTx.sign(kp);

    // Submit
    var sendResult = await rpc.sendTransaction(preparedTx);
    if (sendResult.status === 'ERROR') {
      throw new Error('Submission failed: ' + (sendResult.errorResult || sendResult.status));
    }

    // Poll for confirmation
    var hash = sendResult.hash;
    var getResult;
    for (var i = 0; i < 30; i++) {
      await new Promise(function(r) { setTimeout(r, 2000); });
      getResult = await rpc.getTransaction(hash);
      if (getResult.status !== 'NOT_FOUND') break;
    }

    if (!getResult || getResult.status === 'NOT_FOUND') {
      throw new Error('Transaction not confirmed after 60 seconds');
    }
    if (getResult.status === 'FAILED') {
      throw new Error('Transaction failed on-chain');
    }

    getResult.hash = hash;
    return getResult;
  }

  // ── Read-only queries ──────────────────────────────────────

  async function queryContract(method, params) {
    var pubKey = getPublicKey();
    var sourceForSim = pubKey || 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

    var rpc = getRpc();
    var account = await rpc.getAccount(sourceForSim);

    var contract = new StellarSdk.Contract(ESCROW_CONTRACT);
    var tx = new StellarSdk.TransactionBuilder(account, {
      fee: '100',
      networkPassphrase: NETWORK_PASSPHRASE,
    })
    .addOperation(contract.call(method, ...params))
    .setTimeout(30)
    .build();

    var simResult = await rpc.simulateTransaction(tx);
    if (StellarSdk.SorobanRpc.Api.isSimulationError(simResult)) {
      throw new Error('Query failed: ' + (simResult.error || 'unknown'));
    }

    return simResult.result;
  }

  // ── ScVal helpers ──────────────────────────────────────────

  function addressVal(addr) {
    return new StellarSdk.Address(addr).toScVal();
  }

  function i128Val(amount) {
    return StellarSdk.nativeToScVal(amount, { type: 'i128' });
  }

  function u32Val(num) {
    return StellarSdk.xdr.ScVal.scvU32(num);
  }

  function u64Val(num) {
    return StellarSdk.nativeToScVal(num, { type: 'u64' });
  }

  function boolVal(b) {
    return StellarSdk.xdr.ScVal.scvBool(b);
  }

  function toStroops(amount) {
    return BigInt(Math.round(amount * STROOPS));
  }

  function fromStroops(stroops) {
    return Number(stroops) / STROOPS;
  }

  // ── Public API: Write operations ───────────────────────────

  /**
   * Approve the escrow contract to spend the buyer's OLIGHFT tokens.
   * Must be called BEFORE create_fund or fund.
   * @param {number} amountOLIGHFT - Amount to approve (should cover amount + fee)
   * @returns {Promise<{txHash: string}>}
   */
  async function approveToken(amountOLIGHFT) {
    var kp = getWalletKeypair();
    if (!kp) throw new Error('Wallet not connected');

    var rpc = getRpc();
    var account = await rpc.getAccount(kp.publicKey());

    var tokenContract = new StellarSdk.Contract(TOKEN_CONTRACT);
    var amount = toStroops(amountOLIGHFT);

    // approve(from, spender, amount, expiration_ledger)
    // Set expiration ~1 hour ahead (~720 ledgers)
    var currentLedger = (await rpc.getLatestLedger()).sequence;
    var expirationLedger = currentLedger + 720;

    var tx = new StellarSdk.TransactionBuilder(account, {
      fee: '100000',
      networkPassphrase: NETWORK_PASSPHRASE,
    })
    .addOperation(tokenContract.call(
      'approve',
      new StellarSdk.Address(kp.publicKey()).toScVal(),
      new StellarSdk.Address(ESCROW_CONTRACT).toScVal(),
      i128Val(amount),
      StellarSdk.xdr.ScVal.scvU32(expirationLedger)
    ))
    .setTimeout(120)
    .build();

    var simResult = await rpc.simulateTransaction(tx);
    if (StellarSdk.SorobanRpc.Api.isSimulationError(simResult)) {
      throw new Error('Approve error: ' + (simResult.error || 'Simulation failed'));
    }

    var preparedTx = StellarSdk.SorobanRpc.assembleTransaction(tx, simResult).build();
    preparedTx.sign(kp);

    var sendResult = await rpc.sendTransaction(preparedTx);
    if (sendResult.status === 'ERROR') {
      throw new Error('Approve submission failed: ' + sendResult.status);
    }

    var hash = sendResult.hash;
    var getResult;
    for (var i = 0; i < 30; i++) {
      await new Promise(function(r) { setTimeout(r, 2000); });
      getResult = await rpc.getTransaction(hash);
      if (getResult.status !== 'NOT_FOUND') break;
    }
    if (!getResult || getResult.status === 'FAILED') {
      throw new Error('Approve transaction failed');
    }

    return { txHash: hash };
  }

  /**
   * Create a new escrow (two-step: creates Pending, then fund separately)
   * @param {string} sellerAddr - Seller's Stellar public key
   * @param {string} arbiterAddr - Arbiter's Stellar public key
   * @param {number} amountOLIGHFT - Amount in OLIGHFT
   * @param {number} deadlineDays - Deadline in days (0 = default 30)
   * @param {number} descriptionHash - Hash of description text
   * @returns {Promise<{escrowId: number, txHash: string}>}
   */
  async function createEscrow(sellerAddr, arbiterAddr, amountOLIGHFT, deadlineDays, descriptionHash) {
    var kp = getWalletKeypair();
    if (!kp) throw new Error('Wallet not connected');

    // Validate Stellar addresses
    if (!sellerAddr || sellerAddr.length !== 56 || sellerAddr[0] !== 'G') {
      throw new Error('Invalid seller address — must be a valid Stellar public key');
    }
    if (!arbiterAddr || arbiterAddr.length !== 56 || arbiterAddr[0] !== 'G') {
      throw new Error('Invalid arbiter address — must be a valid Stellar public key');
    }
    if (amountOLIGHFT <= 0) throw new Error('Amount must be positive');

    var buyer = new StellarSdk.Address(kp.publicKey());
    var amount = toStroops(amountOLIGHFT);

    var result = await buildAndSubmitTx('create_escrow', [
      buyer.toScVal(),
      addressVal(sellerAddr),
      addressVal(arbiterAddr),
      addressVal(TOKEN_CONTRACT),
      i128Val(amount),
      u32Val(deadlineDays || 0),
      u64Val(descriptionHash || 0),
    ]);

    var escrowId = 0;
    if (result.returnValue) {
      escrowId = Number(StellarSdk.scValToNative(result.returnValue));
    }

    return { escrowId: escrowId, txHash: result.hash || '' };
  }

  /**
   * Combined create + fund in one transaction.
   * Calls the contract's create_fund method which creates and locks
   * tokens in a single atomic operation.
   * IMPORTANT: Call approveToken() first with the total (amount + fee).
   * @param {string} sellerAddr - Seller's Stellar public key
   * @param {string} arbiterAddr - Arbiter's Stellar public key
   * @param {number} amountOLIGHFT - Amount in OLIGHFT
   * @param {number} deadlineDays - Deadline in days (0 = default 30)
   * @param {number} descriptionHash - Hash of description text
   * @returns {Promise<{escrowId: number, txHash: string}>}
   */
  async function createAndFundEscrow(sellerAddr, arbiterAddr, amountOLIGHFT, deadlineDays, descriptionHash) {
    var kp = getWalletKeypair();
    if (!kp) throw new Error('Wallet not connected');

    // Validate Stellar addresses
    if (!sellerAddr || sellerAddr.length !== 56 || sellerAddr[0] !== 'G') {
      throw new Error('Invalid seller address — must be a valid Stellar public key');
    }
    if (!arbiterAddr || arbiterAddr.length !== 56 || arbiterAddr[0] !== 'G') {
      throw new Error('Invalid arbiter address — must be a valid Stellar public key');
    }
    if (amountOLIGHFT <= 0) throw new Error('Amount must be positive');

    var buyer = new StellarSdk.Address(kp.publicKey());
    var amount = toStroops(amountOLIGHFT);

    var result = await buildAndSubmitTx('create_fund', [
      buyer.toScVal(),
      addressVal(sellerAddr),
      addressVal(arbiterAddr),
      addressVal(TOKEN_CONTRACT),
      i128Val(amount),
      u32Val(deadlineDays || 0),
      u64Val(descriptionHash || 0),
    ]);

    var escrowId = 0;
    if (result.returnValue) {
      escrowId = Number(StellarSdk.scValToNative(result.returnValue));
    }

    return { escrowId: escrowId, txHash: result.hash || '' };
  }

  /**
   * Fund an existing escrow (transfers tokens to contract)
   * @param {number} escrowId
   * @returns {Promise<{txHash: string}>}
   */
  async function fundEscrow(escrowId) {
    var result = await buildAndSubmitTx('fund', [
      u64Val(escrowId),
    ]);
    return { txHash: result.hash || '' };
  }

  /**
   * Release escrowed funds to the seller
   * @param {number} escrowId
   * @returns {Promise<{txHash: string}>}
   */
  async function releaseEscrow(escrowId) {
    var kp = getWalletKeypair();
    if (!kp) throw new Error('Wallet not connected');
    var result = await buildAndSubmitTx('release', [
      u64Val(escrowId),
    ]);
    return { txHash: result.hash || '' };
  }

  /**
   * Raise a dispute on a funded escrow
   * @param {number} escrowId
   * @returns {Promise<{txHash: string}>}
   */
  async function disputeEscrow(escrowId) {
    var kp = getWalletKeypair();
    if (!kp) throw new Error('Wallet not connected');
    var caller = new StellarSdk.Address(kp.publicKey());

    var result = await buildAndSubmitTx('dispute', [
      caller.toScVal(),
      u64Val(escrowId),
    ]);
    return { txHash: result.hash || '' };
  }

  /**
   * Arbiter resolves a disputed escrow
   * @param {number} escrowId
   * @param {boolean} releaseToSeller - true = seller wins, false = buyer refund
   * @returns {Promise<{txHash: string}>}
   */
  async function resolveEscrow(escrowId, releaseToSeller) {
    var kp = getWalletKeypair();
    if (!kp) throw new Error('Wallet not connected');
    var result = await buildAndSubmitTx('resolve', [
      u64Val(escrowId),
      boolVal(releaseToSeller),
    ]);
    return { txHash: result.hash || '' };
  }

  /**
   * Refund an expired escrow back to buyer
   * @param {number} escrowId
   * @returns {Promise<{txHash: string}>}
   */
  async function refundExpired(escrowId) {
    var kp = getWalletKeypair();
    if (!kp) throw new Error('Wallet not connected');
    var result = await buildAndSubmitTx('refund_expired', [
      u64Val(escrowId),
    ]);
    return { txHash: result.hash || '' };
  }

  /**
   * Cancel a pending (unfunded) escrow
   * @param {number} escrowId
   * @returns {Promise<{txHash: string}>}
   */
  async function cancelEscrow(escrowId) {
    var kp = getWalletKeypair();
    if (!kp) throw new Error('Wallet not connected');
    var result = await buildAndSubmitTx('cancel', [
      u64Val(escrowId),
    ]);
    return { txHash: result.hash || '' };
  }

  // ── Public API: Read operations ────────────────────────────

  /**
   * Get escrow details by ID
   * @param {number} escrowId
   * @returns {Promise<Object>}
   */
  async function getEscrow(escrowId) {
    try {
      var result = await queryContract('get_escrow', [u64Val(escrowId)]);
      if (!result) return null;
      var native = StellarSdk.scValToNative(result.retval || result);
      return {
        id: Number(native.id),
        buyer: native.buyer,
        seller: native.seller,
        arbiter: native.arbiter,
        token: native.token,
        amount: fromStroops(native.amount),
        fee: fromStroops(native.fee),
        status: Number(native.status),
        statusLabel: STATUS[Number(native.status)] || 'Unknown',
        createdLedger: Number(native.created_ledger),
        fundedLedger: Number(native.funded_ledger),
        deadlineLedger: Number(native.deadline_ledger),
        descriptionHash: Number(native.description_hash),
      };
    } catch(e) {
      console.warn('getEscrow query failed:', e);
      return null;
    }
  }

  /**
   * Get all escrow IDs where current user is the buyer
   * @returns {Promise<number[]>}
   */
  async function getBuyerEscrows() {
    var pubKey = getPublicKey();
    if (!pubKey) return [];
    try {
      var result = await queryContract('get_buyer_escrows', [addressVal(pubKey)]);
      if (!result) return [];
      return StellarSdk.scValToNative(result.retval || result).map(Number);
    } catch(e) {
      console.warn('getBuyerEscrows failed:', e);
      return [];
    }
  }

  /**
   * Get all escrow IDs where current user is the seller
   * @returns {Promise<number[]>}
   */
  async function getSellerEscrows() {
    var pubKey = getPublicKey();
    if (!pubKey) return [];
    try {
      var result = await queryContract('get_seller_escrows', [addressVal(pubKey)]);
      if (!result) return [];
      return StellarSdk.scValToNative(result.retval || result).map(Number);
    } catch(e) {
      console.warn('getSellerEscrows failed:', e);
      return [];
    }
  }

  // ── localStorage fallback for offline/testnet ──────────────

  function saveEscrowLocal(escrow) {
    var all = [];
    try { all = JSON.parse(localStorage.getItem('cw_escrows') || '[]'); } catch(e) { all = []; }
    // Update or insert
    var found = false;
    for (var i = 0; i < all.length; i++) {
      if (all[i].id === escrow.id) { all[i] = escrow; found = true; break; }
    }
    if (!found) all.push(escrow);
    localStorage.setItem('cw_escrows', JSON.stringify(all));
  }

  function getLocalEscrows() {
    try { return JSON.parse(localStorage.getItem('cw_escrows') || '[]'); } catch(e) { return []; }
  }

  function getLocalEscrow(id) {
    var all = getLocalEscrows();
    for (var i = 0; i < all.length; i++) {
      if (all[i].id === id) return all[i];
    }
    return null;
  }

  /**
   * Create escrow locally (offline mode / testnet fallback)
   */
  function createEscrowLocal(seller, amount, deadlineDays, description) {
    var user = null;
    try { user = JSON.parse(localStorage.getItem('cw_user')); } catch(e) {}
    if (!user) throw new Error('Not logged in');

    var all = getLocalEscrows();
    var id = all.length > 0 ? Math.max.apply(null, all.map(function(e) { return e.id; })) + 1 : 1;
    var fee = amount * 0.005; // 0.5% fee

    var escrow = {
      id: id,
      buyer: user.email,
      buyerName: user.name,
      seller: seller,
      arbiter: 'admin',
      token: 'OLIGHFT',
      amount: amount,
      fee: fee,
      status: 0,
      statusLabel: 'Pending',
      description: description || '',
      createdAt: Date.now(),
      fundedAt: 0,
      deadlineMs: Date.now() + ((deadlineDays || 30) * 86400000),
      txHash: 'esc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    };

    saveEscrowLocal(escrow);

    // Log activity
    try {
      var al = JSON.parse(localStorage.getItem('cw_activity') || '[]');
      al.unshift({
        type: 'Escrow Created',
        icon: '\uD83D\uDD12',
        detail: 'Escrow #' + id + ' for ' + amount.toFixed(2) + ' OLIGHFT to ' + seller,
        amt: '-' + amount.toFixed(2) + ' OLIGHFT',
        cls: 'orange',
        time: 'Just now',
        ts: Date.now()
      });
      if (al.length > 50) al.length = 50;
      localStorage.setItem('cw_activity', JSON.stringify(al));
    } catch(e) {}

    return escrow;
  }

  /**
   * Fund escrow locally
   */
  function fundEscrowLocal(escrowId) {
    var escrow = getLocalEscrow(escrowId);
    if (!escrow) throw new Error('Escrow not found');
    if (escrow.status !== 0) throw new Error('Escrow already funded');

    var total = escrow.amount + escrow.fee;

    // Deduct from balance
    var bals = {};
    try { bals = JSON.parse(localStorage.getItem('cw_balances') || '{}'); } catch(e) {}
    if ((bals.OLIGHFT || 0) < total) throw new Error('Insufficient OLIGHFT balance');
    bals.OLIGHFT = (bals.OLIGHFT || 0) - total;
    localStorage.setItem('cw_balances', JSON.stringify(bals));

    escrow.status = 1;
    escrow.statusLabel = 'Funded';
    escrow.fundedAt = Date.now();
    saveEscrowLocal(escrow);

    return escrow;
  }

  /**
   * Release escrow locally (buyer confirms delivery)
   */
  function releaseEscrowLocal(escrowId) {
    var escrow = getLocalEscrow(escrowId);
    if (!escrow) throw new Error('Escrow not found');
    if (escrow.status !== 1) throw new Error('Escrow not funded');

    // Credit seller balance
    var sellerKey = 'cw_sponsor_bal_' + escrow.seller.toLowerCase();
    var sellerBal = parseFloat(localStorage.getItem(sellerKey) || '0');
    sellerBal += escrow.amount;
    localStorage.setItem(sellerKey, sellerBal.toString());

    escrow.status = 2;
    escrow.statusLabel = 'Completed';
    saveEscrowLocal(escrow);

    // Log
    try {
      var al = JSON.parse(localStorage.getItem('cw_activity') || '[]');
      al.unshift({
        type: 'Escrow Released',
        icon: '\u2705',
        detail: 'Released #' + escrowId + ': ' + escrow.amount.toFixed(2) + ' OLIGHFT to ' + escrow.seller,
        amt: escrow.amount.toFixed(2) + ' OLIGHFT',
        cls: 'green',
        time: 'Just now',
        ts: Date.now()
      });
      if (al.length > 50) al.length = 50;
      localStorage.setItem('cw_activity', JSON.stringify(al));
    } catch(e) {}

    return escrow;
  }

  /**
   * Dispute escrow locally
   */
  function disputeEscrowLocal(escrowId) {
    var escrow = getLocalEscrow(escrowId);
    if (!escrow) throw new Error('Escrow not found');
    if (escrow.status !== 1) throw new Error('Escrow not funded');

    escrow.status = 3;
    escrow.statusLabel = 'Disputed';
    saveEscrowLocal(escrow);
    return escrow;
  }

  /**
   * Refund expired escrow locally
   */
  function refundEscrowLocal(escrowId) {
    var escrow = getLocalEscrow(escrowId);
    if (!escrow) throw new Error('Escrow not found');
    if (escrow.status !== 1) throw new Error('Escrow not funded');
    if (Date.now() < escrow.deadlineMs) throw new Error('Deadline not expired');

    var total = escrow.amount + escrow.fee;
    var bals = {};
    try { bals = JSON.parse(localStorage.getItem('cw_balances') || '{}'); } catch(e) {}
    bals.OLIGHFT = (bals.OLIGHFT || 0) + total;
    localStorage.setItem('cw_balances', JSON.stringify(bals));

    escrow.status = 5;
    escrow.statusLabel = 'Refunded';
    saveEscrowLocal(escrow);
    return escrow;
  }

  /**
   * Cancel unfunded escrow locally
   */
  function cancelEscrowLocal(escrowId) {
    var escrow = getLocalEscrow(escrowId);
    if (!escrow) throw new Error('Escrow not found');
    if (escrow.status !== 0) throw new Error('Can only cancel pending escrows');

    escrow.status = 6;
    escrow.statusLabel = 'Cancelled';
    saveEscrowLocal(escrow);
    return escrow;
  }

  // ── Public interface ───────────────────────────────────────

  return {
    // Config
    ESCROW_CONTRACT: ESCROW_CONTRACT,
    TOKEN_CONTRACT: TOKEN_CONTRACT,
    STATUS: STATUS,
    toStroops: toStroops,
    fromStroops: fromStroops,

    // On-chain write operations
    approveToken: approveToken,
    createEscrow: createEscrow,
    createAndFundEscrow: createAndFundEscrow,
    fundEscrow: fundEscrow,
    releaseEscrow: releaseEscrow,
    disputeEscrow: disputeEscrow,
    resolveEscrow: resolveEscrow,
    refundExpired: refundExpired,
    cancelEscrow: cancelEscrow,

    // On-chain read operations
    getEscrow: getEscrow,
    getBuyerEscrows: getBuyerEscrows,
    getSellerEscrows: getSellerEscrows,

    // Local/offline operations (testnet fallback)
    createEscrowLocal: createEscrowLocal,
    fundEscrowLocal: fundEscrowLocal,
    releaseEscrowLocal: releaseEscrowLocal,
    disputeEscrowLocal: disputeEscrowLocal,
    refundEscrowLocal: refundEscrowLocal,
    cancelEscrowLocal: cancelEscrowLocal,
    getLocalEscrows: getLocalEscrows,
    getLocalEscrow: getLocalEscrow,
    saveEscrowLocal: saveEscrowLocal,

    // Helpers
    isWalletConnected: isWalletConnected,
    getPublicKey: getPublicKey,
  };
})();
