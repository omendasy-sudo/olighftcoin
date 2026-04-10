// ═══════════════════════════════════════════════════════════════
//  OLIGHFT SMART COIN — Automatic P2P Trading Backend
//  Connects the dashboard to the deployed P2P contract
//  on Stellar Testnet via Soroban RPC.
//  Order book with automatic matching engine.
// ═══════════════════════════════════════════════════════════════

const P2P_BACKEND = (function() {
  'use strict';

  // ── Contract & Network Config ──────────────────────────────
  const P2P_CONTRACT   = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP2P';  // Replace after deploy
  const TOKEN_CONTRACT = 'CA5NW2ZJISLPTRRPEFY7XIKSB5CZ5XF2PIARJL2F37H7EPRAXXD34W6J';
  const USDC_CONTRACT  = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAUSDC'; // Replace after deploy
  const SOROBAN_RPC_URL    = 'https://soroban-testnet.stellar.org';
  const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';
  const DECIMALS = 7;
  const STROOPS  = 10_000_000;
  const TOKEN_PRICE = 0.50; // Default OLIGHFT price in USDC

  // Order side enum (must match contract)
  const SIDE = { BUY: 0, SELL: 1 };
  const SIDE_LABEL = { 0: 'Buy', 1: 'Sell' };

  // Order status enum (must match contract)
  const STATUS = { ACTIVE: 0, FILLED: 1, PARTIAL: 2, CANCELLED: 3, EXPIRED: 4 };
  const STATUS_LABEL = { 0: 'Active', 1: 'Filled', 2: 'Partial', 3: 'Cancelled', 4: 'Expired' };

  // Payment proof status
  const PROOF_STATUS = {
    PENDING:   0,  // Awaiting buyer payment proof
    SUBMITTED: 1,  // Buyer uploaded proof screenshot + receipt code
    CONFIRMED: 2,  // Seller confirmed payment received
    DISPUTED:  3,  // Seller disputed the proof
    RELEASED:  4,  // Funds released to buyer
  };
  const PROOF_LABEL = {
    0: 'Awaiting Proof',
    1: 'Proof Submitted',
    2: 'Payment Confirmed',
    3: 'Disputed',
    4: 'Released',
  };

  // ── Payment Methods ────────────────────────────────────────
  const PAYMENT_METHODS = [
    // ── Mobile Money: East Africa ──
    { id: 'mpesa',       label: 'M-Pesa (Safaricom)',    icon: '\uD83D\uDCF1', category: 'mobile' },
    { id: 'airtel',      label: 'Airtel Money',          icon: '\uD83D\uDCF1', category: 'mobile' },
    { id: 'tkash',       label: 'T-Kash (Telkom)',       icon: '\uD83D\uDCF1', category: 'mobile' },
    { id: 'equitel',     label: 'Equitel Money',         icon: '\uD83D\uDCF1', category: 'mobile' },
    { id: 'alopesa',     label: 'Alo Pesa',              icon: '\uD83D\uDCF2', category: 'mobile' },
    { id: 'yass',        label: 'Yass',                  icon: '\uD83D\uDCF2', category: 'mobile' },
    { id: 'halopesa',    label: 'HaloPesa (Halotel)',    icon: '\uD83D\uDCF1', category: 'mobile' },
    { id: 'tigo',        label: 'Tigo Pesa',             icon: '\uD83D\uDCF1', category: 'mobile' },
    { id: 'vodacom',     label: 'Vodacom M-Pesa',        icon: '\uD83D\uDCF1', category: 'mobile' },
    // ── Mobile Money: West Africa ──
    { id: 'mtn',         label: 'MTN Mobile Money',      icon: '\uD83D\uDCF1', category: 'mobile' },
    { id: 'orange',      label: 'Orange Money',          icon: '\uD83D\uDCF1', category: 'mobile' },
    { id: 'wave',        label: 'Wave',                  icon: '\uD83C\uDF0A', category: 'mobile' },
    { id: 'moov',        label: 'Moov Money',            icon: '\uD83D\uDCF1', category: 'mobile' },
    { id: 'glo',         label: 'Glo Mobile Money',      icon: '\uD83D\uDCF1', category: 'mobile' },
    { id: '9mobile',     label: '9mobile Money',         icon: '\uD83D\uDCF1', category: 'mobile' },
    // ── Mobile Money: Southern Africa ──
    { id: 'ecocash',     label: 'EcoCash',               icon: '\uD83D\uDCF1', category: 'mobile' },
    { id: 'telecash',    label: 'TeleCash',              icon: '\uD83D\uDCF1', category: 'mobile' },
    { id: 'onemoney',    label: 'OneMoney',              icon: '\uD83D\uDCF1', category: 'mobile' },
    { id: 'zamtel',      label: 'Zamtel Money',          icon: '\uD83D\uDCF1', category: 'mobile' },
    { id: 'tnm',         label: 'TNM Mpamba',            icon: '\uD83D\uDCF1', category: 'mobile' },
    // ── Mobile Money: Global ──
    { id: 'vodafone',    label: 'Vodafone Cash',         icon: '\uD83D\uDCF1', category: 'mobile' },
    { id: 'gcash',       label: 'GCash',                 icon: '\uD83D\uDCF1', category: 'mobile' },
    { id: 'dana',        label: 'DANA',                  icon: '\uD83D\uDCF1', category: 'mobile' },
    { id: 'chipper',     label: 'Chipper Cash',          icon: '\uD83D\uDCF1', category: 'mobile' },
    { id: 'sim_direct',  label: 'SIM Card Direct',       icon: '\uD83D\uDCF2', category: 'mobile' },
    // ── Bank ──
    { id: 'bank',        label: 'Bank Transfer',         icon: '\uD83C\uDFE6', category: 'bank' },
    { id: 'wire',        label: 'Wire Transfer',         icon: '\uD83C\uDFE6', category: 'bank' },
    { id: 'sepa',        label: 'SEPA Transfer',         icon: '\uD83C\uDFE6', category: 'bank' },
    { id: 'ach',         label: 'ACH Transfer',          icon: '\uD83C\uDFE6', category: 'bank' },
    { id: 'paypal',      label: 'PayPal',                icon: '\uD83D\uDCB3', category: 'online' },
    { id: 'venmo',       label: 'Venmo',                 icon: '\uD83D\uDCB3', category: 'online' },
    { id: 'cashapp',     label: 'Cash App',              icon: '\uD83D\uDCB5', category: 'online' },
    { id: 'zelle',       label: 'Zelle',                 icon: '\uD83D\uDCB5', category: 'online' },
    { id: 'revolut',     label: 'Revolut',               icon: '\uD83D\uDCB3', category: 'online' },
    { id: 'wise',        label: 'Wise (TransferWise)',   icon: '\uD83C\uDF10', category: 'online' },
    { id: 'skrill',      label: 'Skrill',                icon: '\uD83D\uDCB3', category: 'online' },
    { id: 'card_visa',   label: 'Visa Card',             icon: '\uD83D\uDCB3', category: 'card' },
    { id: 'card_master', label: 'Mastercard',            icon: '\uD83D\uDCB3', category: 'card' },
    { id: 'crypto',      label: 'Other Crypto',          icon: '\u26A1',        category: 'crypto' },
    { id: 'cash',        label: 'Cash (In Person)',      icon: '\uD83D\uDCB5', category: 'cash' },
  ];

  function getPaymentLabel(id) {
    for (var i = 0; i < PAYMENT_METHODS.length; i++) {
      if (PAYMENT_METHODS[i].id === id) return PAYMENT_METHODS[i];
    }
    return { id: id, label: id, icon: '\uD83D\uDCB3', category: 'other' };
  }

  // ── SDK References ─────────────────────────────────────────
  var rpcServer = null;

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

    var contract = new StellarSdk.Contract(P2P_CONTRACT);
    var tx = new StellarSdk.TransactionBuilder(account, {
      fee: '100000',
      networkPassphrase: NETWORK_PASSPHRASE,
    })
    .addOperation(contract.call(method, ...params))
    .setTimeout(120)
    .build();

    var simResult = await rpc.simulateTransaction(tx);
    if (StellarSdk.SorobanRpc.Api.isSimulationError(simResult)) {
      throw new Error('Contract error: ' + (simResult.error || 'Simulation failed'));
    }

    var preparedTx = StellarSdk.SorobanRpc.assembleTransaction(tx, simResult).build();
    preparedTx.sign(kp);

    var sendResult = await rpc.sendTransaction(preparedTx);
    if (sendResult.status === 'ERROR') {
      throw new Error('Submission failed: ' + (sendResult.errorResult || sendResult.status));
    }

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

    var contract = new StellarSdk.Contract(P2P_CONTRACT);
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

  function toStroops(amount) {
    return BigInt(Math.round(amount * STROOPS));
  }

  function fromStroops(stroops) {
    return Number(stroops) / STROOPS;
  }

  // ── Public API: On-chain write operations ──────────────────

  /**
   * Approve the P2P contract to spend tokens (call before placing order).
   * @param {string} tokenAddr - Token contract to approve
   * @param {number} amount - Amount in human-readable units
   */
  async function approveToken(tokenAddr, amount) {
    var kp = getWalletKeypair();
    if (!kp) throw new Error('Wallet not connected');

    var rpc = getRpc();
    var account = await rpc.getAccount(kp.publicKey());

    var tokenContract = new StellarSdk.Contract(tokenAddr);
    var stroopAmt = toStroops(amount);

    var currentLedger = (await rpc.getLatestLedger()).sequence;
    var expirationLedger = currentLedger + 720;

    var tx = new StellarSdk.TransactionBuilder(account, {
      fee: '100000',
      networkPassphrase: NETWORK_PASSPHRASE,
    })
    .addOperation(tokenContract.call(
      'approve',
      new StellarSdk.Address(kp.publicKey()).toScVal(),
      new StellarSdk.Address(P2P_CONTRACT).toScVal(),
      i128Val(stroopAmt),
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
   * Place a buy or sell order on-chain.
   * @param {number} side - 0=Buy, 1=Sell
   * @param {number} amount - Amount in OLIGHFT
   * @param {number} price - Price per OLIGHFT in USDC
   * @param {number} expiryDays - 0 = default 7 days
   * @returns {Promise<{orderId: number, txHash: string}>}
   */
  async function placeOrder(side, amount, price, expiryDays) {
    var kp = getWalletKeypair();
    if (!kp) throw new Error('Wallet not connected');

    var owner = new StellarSdk.Address(kp.publicKey());
    var stroopAmount = toStroops(amount);
    var stroopPrice  = toStroops(price);

    var result = await buildAndSubmitTx('place_order', [
      owner.toScVal(),
      u32Val(side),
      addressVal(TOKEN_CONTRACT),
      addressVal(USDC_CONTRACT),
      i128Val(stroopAmount),
      i128Val(stroopPrice),
      u32Val(expiryDays || 0),
    ]);

    var orderId = 0;
    if (result.returnValue) {
      orderId = Number(StellarSdk.scValToNative(result.returnValue));
    }

    return { orderId: orderId, txHash: result.hash || '' };
  }

  /**
   * Cancel an active order on-chain.
   * @param {number} orderId
   * @returns {Promise<{txHash: string}>}
   */
  async function cancelOrder(orderId) {
    var result = await buildAndSubmitTx('cancel_order', [u64Val(orderId)]);
    return { txHash: result.hash || '' };
  }

  // ── Public API: On-chain read operations ───────────────────

  async function getOrder(orderId) {
    try {
      var result = await queryContract('get_order', [u64Val(orderId)]);
      if (!result) return null;
      var native = StellarSdk.scValToNative(result.retval || result);
      return {
        id: Number(native.id),
        owner: native.owner,
        side: Number(native.side),
        sideLabel: SIDE_LABEL[Number(native.side)] || '?',
        token: native.token,
        payToken: native.pay_token,
        amount: fromStroops(native.amount),
        filled: fromStroops(native.filled),
        remaining: fromStroops(native.amount) - fromStroops(native.filled),
        price: fromStroops(native.price),
        status: Number(native.status),
        statusLabel: STATUS_LABEL[Number(native.status)] || 'Unknown',
        createdLedger: Number(native.created_ledger),
        deadlineLedger: Number(native.deadline_ledger),
      };
    } catch(e) {
      console.warn('getOrder query failed:', e);
      return null;
    }
  }

  async function getTrade(tradeId) {
    try {
      var result = await queryContract('get_trade', [u64Val(tradeId)]);
      if (!result) return null;
      var native = StellarSdk.scValToNative(result.retval || result);
      return {
        id: Number(native.id),
        buyOrderId: Number(native.buy_order_id),
        sellOrderId: Number(native.sell_order_id),
        buyer: native.buyer,
        seller: native.seller,
        amount: fromStroops(native.amount),
        price: fromStroops(native.price),
        totalCost: fromStroops(native.total_cost),
        fee: fromStroops(native.fee),
        ledger: Number(native.ledger),
      };
    } catch(e) {
      console.warn('getTrade query failed:', e);
      return null;
    }
  }

  async function getBuyOrders() {
    try {
      var result = await queryContract('get_buy_orders', []);
      if (!result) return [];
      return StellarSdk.scValToNative(result.retval || result).map(Number);
    } catch(e) { return []; }
  }

  async function getSellOrders() {
    try {
      var result = await queryContract('get_sell_orders', []);
      if (!result) return [];
      return StellarSdk.scValToNative(result.retval || result).map(Number);
    } catch(e) { return []; }
  }

  async function getUserOrders() {
    var pubKey = getPublicKey();
    if (!pubKey) return [];
    try {
      var result = await queryContract('get_user_orders', [addressVal(pubKey)]);
      if (!result) return [];
      return StellarSdk.scValToNative(result.retval || result).map(Number);
    } catch(e) { return []; }
  }

  async function getUserTrades() {
    var pubKey = getPublicKey();
    if (!pubKey) return [];
    try {
      var result = await queryContract('get_user_trades', [addressVal(pubKey)]);
      if (!result) return [];
      return StellarSdk.scValToNative(result.retval || result).map(Number);
    } catch(e) { return []; }
  }

  // ── localStorage fallback for offline/testnet ──────────────

  function saveOrderLocal(order) {
    var all = getLocalOrders();
    var found = false;
    for (var i = 0; i < all.length; i++) {
      if (all[i].id === order.id) { all[i] = order; found = true; break; }
    }
    if (!found) all.push(order);
    localStorage.setItem('cw_p2p_orders', JSON.stringify(all));
  }

  function getLocalOrders() {
    try { return JSON.parse(localStorage.getItem('cw_p2p_orders') || '[]'); } catch(e) { return []; }
  }

  function getLocalOrder(id) {
    var all = getLocalOrders();
    for (var i = 0; i < all.length; i++) {
      if (all[i].id === id) return all[i];
    }
    return null;
  }

  function saveTradeLocal(trade) {
    var all = getLocalTrades();
    all.push(trade);
    localStorage.setItem('cw_p2p_trades', JSON.stringify(all));
  }

  function getLocalTrades() {
    try { return JSON.parse(localStorage.getItem('cw_p2p_trades') || '[]'); } catch(e) { return []; }
  }

  function nextLocalId() {
    var all = getLocalOrders();
    return all.length > 0 ? Math.max.apply(null, all.map(function(o) { return o.id; })) + 1 : 1;
  }

  function nextLocalTradeId() {
    var all = getLocalTrades();
    return all.length > 0 ? Math.max.apply(null, all.map(function(t) { return t.id; })) + 1 : 1;
  }

  /**
   * Place order locally with automatic matching engine.
   * @param {number} side - 0=Buy, 1=Sell
   * @param {number} amount - Amount in OLIGHFT
   * @param {number} price - Price per OLIGHFT in USDC
   * @param {number} expiryDays - 0 = default 7
   * @param {string[]} payMethods - array of payment method ids
   * @param {string} payDetails - optional payment details / phone / account info
   * @returns {Object} the created order
   */
  function placeOrderLocal(side, amount, price, expiryDays, payMethods, payDetails) {
    var user = null;
    try { user = JSON.parse(localStorage.getItem('cw_user')); } catch(e) {}
    if (!user) throw new Error('Not logged in');

    if (amount <= 0) throw new Error('Amount must be positive');
    if (price <= 0) throw new Error('Price must be positive');

    var bals = {};
    try { bals = JSON.parse(localStorage.getItem('cw_balances') || '{}'); } catch(e) {}

    var totalCost = amount * price;

    // Lock tokens from maker
    if (side === SIDE.BUY) {
      if ((bals.USDC || 0) < totalCost) throw new Error('Insufficient USDC balance (need ' + totalCost.toFixed(2) + ')');
      bals.USDC = (bals.USDC || 0) - totalCost;
    } else {
      if ((bals.OLIGHFT || 0) < amount) throw new Error('Insufficient OLIGHFT balance (need ' + amount.toFixed(2) + ')');
      bals.OLIGHFT = (bals.OLIGHFT || 0) - amount;
    }
    localStorage.setItem('cw_balances', JSON.stringify(bals));

    var days = expiryDays || 7;
    var id = nextLocalId();
    var order = {
      id: id,
      owner: user.email || user.addr || 'me',
      ownerName: user.name || 'You',
      side: side,
      sideLabel: SIDE_LABEL[side],
      token: 'OLIGHFT',
      payToken: 'USDC',
      amount: amount,
      filled: 0,
      remaining: amount,
      price: price,
      status: STATUS.ACTIVE,
      statusLabel: 'Active',
      createdAt: Date.now(),
      expiresAt: Date.now() + (days * 86400000),
      txHash: 'p2p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      payMethods: payMethods || ['bank'],
      payDetails: payDetails || '',
    };

    saveOrderLocal(order);

    // Log activity
    logActivity(
      side === SIDE.BUY ? 'P2P Buy Order' : 'P2P Sell Order',
      '\uD83D\uDCCA',
      (side === SIDE.BUY ? 'Buy' : 'Sell') + ' ' + amount.toFixed(2) + ' OLIGHFT @ $' + price.toFixed(4),
      (side === SIDE.BUY ? '-' : '-') + amount.toFixed(2) + (side === SIDE.BUY ? ' USDC' : ' OLIGHFT'),
      side === SIDE.BUY ? 'green' : 'red'
    );

    // ── Auto-match engine ──────────────────────────────────
    autoMatchLocal(order);

    return getLocalOrder(id);
  }

  /**
   * Automatic matching engine (local).
   * Matches the taker order against opposing orders in the book.
   */
  function autoMatchLocal(taker) {
    var allOrders = getLocalOrders();
    var matchesCount = 0;
    var maxMatches = 10;

    for (var i = 0; i < allOrders.length; i++) {
      if (matchesCount >= maxMatches) break;

      // Refresh taker state
      taker = getLocalOrder(taker.id);
      if (!taker || taker.status !== STATUS.ACTIVE && taker.status !== STATUS.PARTIAL) break;
      var takerRemaining = taker.amount - taker.filled;
      if (takerRemaining <= 0.0001) break;

      var maker = allOrders[i];

      // Skip same order, same owner, inactive, or same side
      if (maker.id === taker.id) continue;
      if (maker.owner === taker.owner) continue;
      if (maker.status !== STATUS.ACTIVE && maker.status !== STATUS.PARTIAL) continue;
      if (maker.side === taker.side) continue;
      if (Date.now() > maker.expiresAt) continue;

      // Price compatibility
      var pricesMatch = false;
      if (taker.side === SIDE.BUY) {
        pricesMatch = taker.price >= maker.price;
      } else {
        pricesMatch = taker.price <= maker.price;
      }
      if (!pricesMatch) continue;

      // Execute at maker's price
      var execPrice = maker.price;
      var makerRemaining = maker.amount - maker.filled;
      var fillAmount = Math.min(takerRemaining, makerRemaining);
      var fillCost = fillAmount * execPrice;
      var fee = fillAmount * 0.005; // 0.5% fee
      var buyerReceives = fillAmount - fee;

      // Determine buyer/seller
      var buyerOwner, sellerOwner;
      if (taker.side === SIDE.BUY) {
        buyerOwner = taker.owner;
        sellerOwner = maker.owner;
      } else {
        buyerOwner = maker.owner;
        sellerOwner = taker.owner;
      }

      // Credit balances
      var bals = {};
      try { bals = JSON.parse(localStorage.getItem('cw_balances') || '{}'); } catch(e) {}

      // Seller gets USDC
      // (For simplicity in local mode, credit the current user's balances)
      if (sellerOwner === (taker.owner)) {
        bals.USDC = (bals.USDC || 0) + fillCost;
      }
      if (buyerOwner === (taker.owner)) {
        bals.OLIGHFT = (bals.OLIGHFT || 0) + buyerReceives;
      }
      localStorage.setItem('cw_balances', JSON.stringify(bals));

      // Update fills
      taker.filled += fillAmount;
      maker.filled += fillAmount;
      taker.remaining = taker.amount - taker.filled;
      maker.remaining = maker.amount - maker.filled;

      // Update statuses
      if (maker.filled >= maker.amount - 0.0001) {
        maker.status = STATUS.FILLED;
        maker.statusLabel = 'Filled';
      } else {
        maker.status = STATUS.PARTIAL;
        maker.statusLabel = 'Partial';
      }
      saveOrderLocal(maker);

      // Record trade
      // Generate unique receipt code
      var receiptCode = generateReceiptCode();

      var trade = {
        id: nextLocalTradeId(),
        buyOrderId: taker.side === SIDE.BUY ? taker.id : maker.id,
        sellOrderId: taker.side === SIDE.SELL ? taker.id : maker.id,
        buyer: buyerOwner,
        seller: sellerOwner,
        amount: fillAmount,
        price: execPrice,
        totalCost: fillCost,
        fee: fee,
        timestamp: Date.now(),
        receiptCode: receiptCode,
        proofStatus: PROOF_STATUS.PENDING,
        proofLabel: PROOF_LABEL[0],
        proofScreenshot: null,
        proofTxCode: '',
        proofNote: '',
        proofSubmittedAt: 0,
        proofConfirmedAt: 0,
        payMethods: taker.payMethods || maker.payMethods || [],
        payDetails: taker.payDetails || maker.payDetails || '',
      };
      saveTradeLocal(trade);

      logActivity(
        'P2P Trade Executed',
        '\u2705',
        fillAmount.toFixed(2) + ' OLIGHFT @ $' + execPrice.toFixed(4) + ' (fee: ' + fee.toFixed(4) + ')',
        '+' + buyerReceives.toFixed(2) + ' OLIGHFT',
        'green'
      );

      matchesCount++;
    }

    // Final taker status
    taker = getLocalOrder(taker.id);
    if (taker) {
      if (taker.filled >= taker.amount - 0.0001) {
        taker.status = STATUS.FILLED;
        taker.statusLabel = 'Filled';
      } else if (taker.filled > 0) {
        taker.status = STATUS.PARTIAL;
        taker.statusLabel = 'Partial';
      }
      saveOrderLocal(taker);
    }
  }

  /**
   * Cancel order locally. Refund remaining locked tokens.
   * @param {number} orderId
   */
  function cancelOrderLocal(orderId) {
    var order = getLocalOrder(orderId);
    if (!order) throw new Error('Order not found');
    if (order.status !== STATUS.ACTIVE && order.status !== STATUS.PARTIAL) {
      throw new Error('Order not active');
    }

    var remaining = order.amount - order.filled;
    var bals = {};
    try { bals = JSON.parse(localStorage.getItem('cw_balances') || '{}'); } catch(e) {}

    if (remaining > 0) {
      if (order.side === SIDE.BUY) {
        var refund = remaining * order.price;
        bals.USDC = (bals.USDC || 0) + refund;
      } else {
        bals.OLIGHFT = (bals.OLIGHFT || 0) + remaining;
      }
      localStorage.setItem('cw_balances', JSON.stringify(bals));
    }

    order.status = STATUS.CANCELLED;
    order.statusLabel = 'Cancelled';
    saveOrderLocal(order);

    logActivity(
      'P2P Order Cancelled',
      '\u274C',
      'Cancelled ' + SIDE_LABEL[order.side] + ' #' + orderId + ' (' + remaining.toFixed(2) + ' remaining refunded)',
      '+' + remaining.toFixed(2) + (order.side === SIDE.BUY ? ' USDC' : ' OLIGHFT'),
      'orange'
    );

    return order;
  }

  // ── Receipt code generator ─────────────────────────────────

  function generateReceiptCode() {
    var ts = Date.now().toString(36).toUpperCase();
    var rand = Math.random().toString(36).slice(2, 8).toUpperCase();
    return 'OLI-' + ts.slice(-4) + '-' + rand;
  }

  // ── Payment Proof Management ───────────────────────────────

  function getLocalTrade(id) {
    var all = getLocalTrades();
    for (var i = 0; i < all.length; i++) {
      if (all[i].id === id) return all[i];
    }
    return null;
  }

  function updateTradeLocal(trade) {
    var all = getLocalTrades();
    for (var i = 0; i < all.length; i++) {
      if (all[i].id === trade.id) {
        all[i] = trade;
        localStorage.setItem('cw_p2p_trades', JSON.stringify(all));
        return;
      }
    }
  }

  /**
   * Submit payment proof: screenshot (base64 data URL) + transaction receipt code + optional note.
   * Called by the BUYER after sending fiat payment.
   */
  function submitProof(tradeId, screenshotDataUrl, txCode, note) {
    var trade = getLocalTrade(tradeId);
    if (!trade) throw new Error('Trade not found');
    if (trade.proofStatus !== PROOF_STATUS.PENDING && trade.proofStatus !== PROOF_STATUS.DISPUTED) {
      throw new Error('Proof already submitted/confirmed');
    }

    if (!screenshotDataUrl) throw new Error('Please upload a screenshot of your payment');
    if (!txCode || txCode.trim().length < 3) throw new Error('Enter the transaction/receipt code from your payment');

    // Validate the screenshot appears to be a data URL (basic check)
    if (typeof screenshotDataUrl !== 'string' || screenshotDataUrl.indexOf('data:image/') !== 0) {
      throw new Error('Invalid screenshot format');
    }

    trade.proofScreenshot = screenshotDataUrl;
    trade.proofTxCode = txCode.trim();
    trade.proofNote = (note || '').trim();
    trade.proofStatus = PROOF_STATUS.SUBMITTED;
    trade.proofLabel = PROOF_LABEL[PROOF_STATUS.SUBMITTED];
    trade.proofSubmittedAt = Date.now();
    updateTradeLocal(trade);

    logActivity(
      'Payment Proof Sent',
      '\uD83D\uDCF8',
      'Trade #' + tradeId + ' proof submitted. Receipt: ' + txCode.trim(),
      trade.totalCost.toFixed(2) + ' USDC',
      'blue'
    );

    return trade;
  }

  /**
   * Confirm payment received (called by SELLER).
   * Releases escrowed tokens to buyer.
   */
  function confirmProof(tradeId) {
    var trade = getLocalTrade(tradeId);
    if (!trade) throw new Error('Trade not found');
    if (trade.proofStatus !== PROOF_STATUS.SUBMITTED) {
      throw new Error('No proof to confirm');
    }

    trade.proofStatus = PROOF_STATUS.CONFIRMED;
    trade.proofLabel = PROOF_LABEL[PROOF_STATUS.CONFIRMED];
    trade.proofConfirmedAt = Date.now();
    updateTradeLocal(trade);

    logActivity(
      'Payment Confirmed',
      '\u2705',
      'Trade #' + tradeId + ' payment confirmed. Receipt: ' + trade.proofTxCode,
      '+' + trade.amount.toFixed(2) + ' OLIGHFT',
      'green'
    );

    return trade;
  }

  /**
   * Dispute the payment proof (called by SELLER if proof looks fake).
   */
  function disputeProof(tradeId, reason) {
    var trade = getLocalTrade(tradeId);
    if (!trade) throw new Error('Trade not found');
    if (trade.proofStatus !== PROOF_STATUS.SUBMITTED) {
      throw new Error('No proof to dispute');
    }

    trade.proofStatus = PROOF_STATUS.DISPUTED;
    trade.proofLabel = PROOF_LABEL[PROOF_STATUS.DISPUTED];
    trade.disputeReason = (reason || 'Payment not received').trim();
    trade.disputeAt = Date.now();
    updateTradeLocal(trade);

    logActivity(
      'Proof Disputed',
      '\u26A0\uFE0F',
      'Trade #' + tradeId + ' disputed: ' + trade.disputeReason,
      trade.totalCost.toFixed(2) + ' USDC',
      'red'
    );

    return trade;
  }

  // ── Activity logger ────────────────────────────────────────

  function logActivity(type, icon, detail, amt, cls) {
    try {
      var al = JSON.parse(localStorage.getItem('cw_activity') || '[]');
      al.unshift({
        type: type,
        icon: icon,
        detail: detail,
        amt: amt,
        cls: cls,
        time: 'Just now',
        ts: Date.now()
      });
      if (al.length > 50) al.length = 50;
      localStorage.setItem('cw_activity', JSON.stringify(al));
    } catch(e) {}
  }

  // ── Order book helpers ─────────────────────────────────────

  /**
   * Get the active order book (buy & sell sides).
   * Returns { buys: [...], sells: [...] } sorted by best price.
   */
  function getOrderBookLocal() {
    var all = getLocalOrders();
    var buys = [];
    var sells = [];
    var now = Date.now();

    for (var i = 0; i < all.length; i++) {
      var o = all[i];
      if (o.status !== STATUS.ACTIVE && o.status !== STATUS.PARTIAL) continue;
      if (now > o.expiresAt) continue;
      o.remaining = o.amount - o.filled;
      if (o.remaining <= 0.0001) continue;

      if (o.side === SIDE.BUY) {
        buys.push(o);
      } else {
        sells.push(o);
      }
    }

    // Sort buys by highest price first, sells by lowest price first
    buys.sort(function(a, b) { return b.price - a.price; });
    sells.sort(function(a, b) { return a.price - b.price; });

    return { buys: buys, sells: sells };
  }

  /**
   * Get current user's orders.
   */
  function getMyOrdersLocal() {
    var user = null;
    try { user = JSON.parse(localStorage.getItem('cw_user')); } catch(e) {}
    if (!user) return [];
    var email = user.email || user.addr || '';
    var all = getLocalOrders();
    var mine = [];
    for (var i = 0; i < all.length; i++) {
      if (all[i].owner === email) mine.push(all[i]);
    }
    mine.sort(function(a, b) { return b.createdAt - a.createdAt; });
    return mine;
  }

  /**
   * Get current user's trade history.
   */
  function getMyTradesLocal() {
    var user = null;
    try { user = JSON.parse(localStorage.getItem('cw_user')); } catch(e) {}
    if (!user) return [];
    var email = user.email || user.addr || '';
    var all = getLocalTrades();
    var mine = [];
    for (var i = 0; i < all.length; i++) {
      if (all[i].buyer === email || all[i].seller === email) mine.push(all[i]);
    }
    mine.sort(function(a, b) { return b.timestamp - a.timestamp; });
    return mine;
  }

  /**
   * Seed the order book with sample orders for demo/testnet.
   */
  function seedOrderBook() {
    var all = getLocalOrders();
    if (all.length > 0) return; // Already have orders

    var demoOrders = [
      { side: SIDE.SELL, owner: 'alice@demo', ownerName: 'Alice', amount: 500, price: 0.52, filled: 0, pay: ['mpesa','bank'], details: '+254 712 XXX XXX' },
      { side: SIDE.SELL, owner: 'bob@demo',   ownerName: 'Bob',   amount: 1000, price: 0.55, filled: 0, pay: ['bank','paypal'], details: 'PayPal: bob@email.com' },
      { side: SIDE.SELL, owner: 'carol@demo', ownerName: 'Carol', amount: 250, price: 0.51, filled: 0, pay: ['mpesa','airtel','cashapp'], details: '+254 700 XXX XXX' },
      { side: SIDE.BUY,  owner: 'dave@demo',  ownerName: 'Dave',  amount: 800, price: 0.48, filled: 0, pay: ['bank','wire'], details: 'KCB Bank' },
      { side: SIDE.BUY,  owner: 'eve@demo',   ownerName: 'Eve',   amount: 300, price: 0.46, filled: 0, pay: ['mpesa','mtn'], details: '+256 77X XXX XXX' },
      { side: SIDE.BUY,  owner: 'frank@demo', ownerName: 'Frank', amount: 1500, price: 0.49, filled: 0, pay: ['bank','revolut','wise'], details: 'Equity Bank' },
    ];

    for (var i = 0; i < demoOrders.length; i++) {
      var d = demoOrders[i];
      var id = i + 1;
      saveOrderLocal({
        id: id,
        owner: d.owner,
        ownerName: d.ownerName,
        side: d.side,
        sideLabel: SIDE_LABEL[d.side],
        token: 'OLIGHFT',
        payToken: 'USDC',
        amount: d.amount,
        filled: d.filled,
        remaining: d.amount - d.filled,
        price: d.price,
        status: STATUS.ACTIVE,
        statusLabel: 'Active',
        createdAt: Date.now() - (i * 600000),
        expiresAt: Date.now() + (7 * 86400000),
        txHash: 'demo_' + id,
        payMethods: d.pay,
        payDetails: d.details,
      });
    }
  }

  // ── Deposit & Withdraw (Mobile Money / SIM) ───────────────

  var DW_STORAGE_KEY = 'cw_p2p_dw_history';
  var DEPOSIT_FEE_PCT = 0.015;  // 1.5%
  var WITHDRAW_FEE_PCT = 0.02;  // 2%

  // Coin prices in USD for conversion
  var COIN_PRICES = { OLIGHFT: 0.50, USDC: 1.00, XLM: 0.12 };

  // Mobile money providers for deposits/withdrawals
  var MOBILE_PROVIDERS = [
    // East Africa
    { id: 'mpesa', label: 'M-Pesa (Safaricom)', icon: '\uD83C\uDDF0\uD83C\uDDEA' },
    { id: 'airtel', label: 'Airtel Money', icon: '\uD83D\uDCF6' },
    { id: 'tkash', label: 'T-Kash (Telkom)', icon: '\uD83D\uDCDE' },
    { id: 'equitel', label: 'Equitel Money', icon: '\uD83D\uDCF1' },
    { id: 'alopesa', label: 'Alo Pesa', icon: '\uD83D\uDCF2' },
    { id: 'yass', label: 'Yass', icon: '\uD83D\uDCF2' },
    { id: 'halopesa', label: 'HaloPesa (Halotel)', icon: '\uD83D\uDCF1' },
    { id: 'tigo', label: 'Tigo Pesa', icon: '\uD83D\uDCDE' },
    { id: 'vodacom', label: 'Vodacom M-Pesa', icon: '\uD83D\uDCF1' },
    // West Africa
    { id: 'mtn', label: 'MTN MoMo', icon: '\uD83D\uDCF1' },
    { id: 'orange', label: 'Orange Money', icon: '\uD83C\uDF4A' },
    { id: 'wave', label: 'Wave', icon: '\uD83C\uDF0A' },
    { id: 'moov', label: 'Moov Money', icon: '\uD83D\uDCF1' },
    { id: 'glo', label: 'Glo Mobile Money', icon: '\uD83D\uDCF1' },
    { id: '9mobile', label: '9mobile Money', icon: '\uD83D\uDCF1' },
    // Southern Africa
    { id: 'ecocash', label: 'EcoCash', icon: '\uD83D\uDCB2' },
    { id: 'telecash', label: 'TeleCash', icon: '\uD83D\uDCF1' },
    { id: 'onemoney', label: 'OneMoney', icon: '\uD83D\uDCF1' },
    { id: 'zamtel', label: 'Zamtel Money', icon: '\uD83D\uDCF1' },
    { id: 'tnm', label: 'TNM Mpamba', icon: '\uD83D\uDCF1' },
    // Global
    { id: 'vodafone', label: 'Vodafone Cash', icon: '\uD83D\uDCF1' },
    { id: 'gcash', label: 'GCash', icon: '\uD83D\uDCF1' },
    { id: 'dana', label: 'DANA', icon: '\uD83D\uDCF1' },
    { id: 'chipper', label: 'Chipper Cash', icon: '\uD83D\uDCB3' },
  ];

  // Bank providers for deposits/withdrawals
  var BANK_PROVIDERS = [
    // Kenya
    { id: 'kcb', label: 'KCB Bank', icon: '\uD83C\uDFE6', country: 'KE' },
    { id: 'equity', label: 'Equity Bank', icon: '\uD83C\uDFE6', country: 'KE' },
    { id: 'coop', label: 'Co-operative Bank', icon: '\uD83C\uDFE6', country: 'KE' },
    { id: 'absa_ke', label: 'Absa Kenya', icon: '\uD83C\uDFE6', country: 'KE' },
    { id: 'stanbic_ke', label: 'Stanbic Bank Kenya', icon: '\uD83C\uDFE6', country: 'KE' },
    { id: 'dtb', label: 'DTB Bank', icon: '\uD83C\uDFE6', country: 'KE' },
    { id: 'ncba', label: 'NCBA Bank', icon: '\uD83C\uDFE6', country: 'KE' },
    { id: 'im_bank', label: 'I&M Bank', icon: '\uD83C\uDFE6', country: 'KE' },
    { id: 'family', label: 'Family Bank', icon: '\uD83C\uDFE6', country: 'KE' },
    // Nigeria
    { id: 'gtbank', label: 'GTBank', icon: '\uD83C\uDFE6', country: 'NG' },
    { id: 'access', label: 'Access Bank', icon: '\uD83C\uDFE6', country: 'NG' },
    { id: 'zenith', label: 'Zenith Bank', icon: '\uD83C\uDFE6', country: 'NG' },
    { id: 'firstbank', label: 'First Bank', icon: '\uD83C\uDFE6', country: 'NG' },
    { id: 'uba', label: 'UBA', icon: '\uD83C\uDFE6', country: 'NG' },
    // South Africa
    { id: 'fnb', label: 'FNB', icon: '\uD83C\uDFE6', country: 'ZA' },
    { id: 'standard', label: 'Standard Bank', icon: '\uD83C\uDFE6', country: 'ZA' },
    { id: 'nedbank', label: 'Nedbank', icon: '\uD83C\uDFE6', country: 'ZA' },
    { id: 'capitec', label: 'Capitec', icon: '\uD83C\uDFE6', country: 'ZA' },
    { id: 'absa_za', label: 'Absa South Africa', icon: '\uD83C\uDFE6', country: 'ZA' },
    // Tanzania / Uganda / Ghana
    { id: 'crdb', label: 'CRDB Bank', icon: '\uD83C\uDFE6', country: 'TZ' },
    { id: 'nmb', label: 'NMB Bank', icon: '\uD83C\uDFE6', country: 'TZ' },
    { id: 'stanbic_ug', label: 'Stanbic Uganda', icon: '\uD83C\uDFE6', country: 'UG' },
    { id: 'gcb', label: 'GCB Bank Ghana', icon: '\uD83C\uDFE6', country: 'GH' },
    { id: 'ecobank', label: 'Ecobank', icon: '\uD83C\uDFE6', country: 'Multi' },
    // International
    { id: 'wire', label: 'Wire Transfer', icon: '\uD83C\uDF10', country: 'Intl' },
    { id: 'sepa', label: 'SEPA Transfer', icon: '\uD83C\uDDEA\uD83C\uDDFA', country: 'EU' },
    { id: 'ach', label: 'ACH Transfer', icon: '\uD83C\uDDFA\uD83C\uDDF8', country: 'US' },
    { id: 'swift', label: 'SWIFT Transfer', icon: '\uD83C\uDF10', country: 'Intl' },
  ];

  var BANK_DEPOSIT_FEE_PCT = 0.01;   // 1%
  var BANK_WITHDRAW_FEE_PCT = 0.015;  // 1.5%

  // ── Card Providers ─────────────────────────────────────────

  var CARD_PROVIDERS = [
    { id: 'visa', label: 'Visa', icon: '\uD83D\uDCB3', network: 'Visa' },
    { id: 'mastercard', label: 'Mastercard', icon: '\uD83D\uDCB3', network: 'Mastercard' },
    { id: 'amex', label: 'American Express', icon: '\uD83D\uDCB3', network: 'Amex' },
    { id: 'discover', label: 'Discover', icon: '\uD83D\uDCB3', network: 'Discover' },
    { id: 'unionpay', label: 'UnionPay', icon: '\uD83D\uDCB3', network: 'UnionPay' },
    { id: 'verve', label: 'Verve', icon: '\uD83D\uDCB3', network: 'Verve' },
    { id: 'maestro', label: 'Maestro', icon: '\uD83D\uDCB3', network: 'Maestro' },
    { id: 'dinersclub', label: 'Diners Club', icon: '\uD83D\uDCB3', network: 'Diners' },
    { id: 'jcb', label: 'JCB', icon: '\uD83D\uDCB3', network: 'JCB' },
    { id: 'elo', label: 'Elo', icon: '\uD83D\uDCB3', network: 'Elo' },
  ];

  var CARD_DEPOSIT_FEE_PCT = 0.025;   // 2.5%
  var CARD_WITHDRAW_FEE_PCT = 0.03;   // 3%

  function getDWHistory() {
    try { return JSON.parse(localStorage.getItem(DW_STORAGE_KEY) || '[]'); } catch(e) { return []; }
  }
  function saveDWHistory(arr) {
    localStorage.setItem(DW_STORAGE_KEY, JSON.stringify(arr));
  }

  /**
   * Deposit via mobile money into wallet
   * @param {string} coin - OLIGHFT, USDC, or XLM
   * @param {number} usdAmount - USD amount to deposit
   * @param {string} provider - mobile money provider id
   * @param {string} phone - phone number
   * @returns {object} deposit record
   */
  function depositToWallet(coin, usdAmount, provider, phone) {
    if (!coin || !usdAmount || !provider || !phone) throw new Error('All fields are required');
    if (usdAmount < 1) throw new Error('Minimum deposit is $1');
    if (usdAmount > 10000) throw new Error('Maximum deposit is $10,000');
    if (!/^\+?\d[\d\s\-]{6,19}$/.test(phone.trim())) throw new Error('Invalid phone number');

    var price = COIN_PRICES[coin] || 0.50;
    var fee = usdAmount * DEPOSIT_FEE_PCT;
    var netUsd = usdAmount - fee;
    var coinsReceived = netUsd / price;

    var record = {
      id: 'dep_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
      type: 'deposit',
      coin: coin,
      usdAmount: usdAmount,
      fee: fee,
      coinsReceived: coinsReceived,
      provider: provider,
      phone: phone.trim(),
      status: 'pending_proof',
      receiptCode: generateReceiptCode(),
      proofScreenshot: null,
      proofEnteredCode: '',
      proofNote: '',
      proofSubmittedAt: 0,
      proofVerifiedAt: 0,
      rejectReason: '',
      timestamp: Date.now(),
    };

    var history = getDWHistory();
    history.unshift(record);
    saveDWHistory(history);

    // Log to activity
    try {
      var acts = JSON.parse(localStorage.getItem('cw_activity') || '[]');
      acts.unshift({
        type: 'p2p_deposit',
        label: 'Deposit initiated ' + coinsReceived.toFixed(2) + ' ' + coin + ' via ' + provider + ' — awaiting proof',
        amount: '+' + coinsReceived.toFixed(4) + ' ' + coin,
        ts: Date.now()
      });
      localStorage.setItem('cw_activity', JSON.stringify(acts));
    } catch(e) {}

    return record;
  }

  /**
   * Withdraw from wallet to SIM / mobile money
   * @param {string} coin - OLIGHFT, USDC, or XLM
   * @param {number} coinAmount - amount of coins to withdraw
   * @param {string} provider - mobile money provider id
   * @param {string} phone - phone number
   * @returns {object} withdrawal record
   */
  function withdrawToSIM(coin, coinAmount, provider, phone) {
    if (!coin || !coinAmount || !provider || !phone) throw new Error('All fields are required');
    if (coinAmount < 1) throw new Error('Minimum withdrawal is 1 ' + coin);
    if (!/^\+?\d[\d\s\-]{6,19}$/.test(phone.trim())) throw new Error('Invalid phone number');
    if (coinAmount > 100000) throw new Error('Maximum withdrawal is 100,000 ' + coin);

    // Check balance
    var bals = {};
    try { bals = JSON.parse(localStorage.getItem('cw_balances') || '{}'); } catch(e) {}
    var available = bals[coin] || 0;
    if (coinAmount > available) throw new Error('Insufficient ' + coin + ' balance. Available: ' + available.toFixed(4));

    var price = COIN_PRICES[coin] || 0.50;
    var usdValue = coinAmount * price;
    var fee = usdValue * WITHDRAW_FEE_PCT;
    var netUsd = usdValue - fee;

    // Debit wallet balance (escrow — held until proof verified)
    bals[coin] = available - coinAmount;
    if (bals[coin] < 0.0001) bals[coin] = 0;
    localStorage.setItem('cw_balances', JSON.stringify(bals));

    var record = {
      id: 'wd_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
      type: 'withdraw',
      coin: coin,
      coinAmount: coinAmount,
      usdValue: usdValue,
      fee: fee,
      netUsd: netUsd,
      provider: provider,
      phone: phone.trim(),
      status: 'pending_proof',
      receiptCode: generateReceiptCode(),
      proofScreenshot: null,
      proofEnteredCode: '',
      proofNote: '',
      proofSubmittedAt: 0,
      proofVerifiedAt: 0,
      rejectReason: '',
      timestamp: Date.now(),
    };

    var history = getDWHistory();
    history.unshift(record);
    saveDWHistory(history);

    // Log to activity
    try {
      var acts = JSON.parse(localStorage.getItem('cw_activity') || '[]');
      acts.unshift({
        type: 'p2p_withdraw',
        label: 'Withdrawal initiated ' + coinAmount.toFixed(2) + ' ' + coin + ' to ' + phone.trim() + ' — awaiting proof',
        amount: '-' + coinAmount.toFixed(4) + ' ' + coin,
        ts: Date.now()
      });
      localStorage.setItem('cw_activity', JSON.stringify(acts));
    } catch(e) {}

    return record;
  }

  function getDepositHistory() {
    return getDWHistory().filter(function(r) { return r.type === 'deposit'; });
  }

  function getWithdrawHistory() {
    return getDWHistory().filter(function(r) { return r.type === 'withdraw'; });
  }

  function getBankDepositHistory() {
    return getDWHistory().filter(function(r) { return r.type === 'bank_deposit'; });
  }

  function getBankWithdrawHistory() {
    return getDWHistory().filter(function(r) { return r.type === 'bank_withdraw'; });
  }

  /**
   * Deposit via bank transfer into wallet
   */
  function depositViaBank(coin, usdAmount, bankId, accountNumber, accountName) {
    if (!coin || !usdAmount || !bankId || !accountNumber || !accountName) throw new Error('All fields are required');
    if (usdAmount < 5) throw new Error('Minimum bank deposit is $5');
    if (usdAmount > 50000) throw new Error('Maximum bank deposit is $50,000');
    if (accountNumber.trim().length < 5) throw new Error('Invalid account number');
    if (accountName.trim().length < 2) throw new Error('Invalid account holder name');

    var price = COIN_PRICES[coin] || 0.50;
    var fee = usdAmount * BANK_DEPOSIT_FEE_PCT;
    var netUsd = usdAmount - fee;
    var coinsReceived = netUsd / price;

    var record = {
      id: 'bdep_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
      type: 'bank_deposit',
      coin: coin,
      usdAmount: usdAmount,
      fee: fee,
      coinsReceived: coinsReceived,
      bankId: bankId,
      accountNumber: accountNumber.trim(),
      accountName: accountName.trim(),
      status: 'pending_proof',
      receiptCode: generateReceiptCode(),
      proofScreenshot: null,
      proofEnteredCode: '',
      proofNote: '',
      proofSubmittedAt: 0,
      proofVerifiedAt: 0,
      rejectReason: '',
      timestamp: Date.now(),
    };

    var history = getDWHistory();
    history.unshift(record);
    saveDWHistory(history);

    try {
      var acts = JSON.parse(localStorage.getItem('cw_activity') || '[]');
      acts.unshift({
        type: 'bank_deposit',
        label: 'Bank deposit initiated ' + coinsReceived.toFixed(2) + ' ' + coin + ' via ' + bankId + ' — awaiting proof',
        amount: '+' + coinsReceived.toFixed(4) + ' ' + coin,
        ts: Date.now()
      });
      localStorage.setItem('cw_activity', JSON.stringify(acts));
    } catch(e) {}

    return record;
  }

  /**
   * Withdraw from wallet to bank account
   */
  function withdrawToBank(coin, coinAmount, bankId, accountNumber, accountName) {
    if (!coin || !coinAmount || !bankId || !accountNumber || !accountName) throw new Error('All fields are required');
    if (coinAmount < 1) throw new Error('Minimum withdrawal is 1 ' + coin);
    if (coinAmount > 100000) throw new Error('Maximum withdrawal is 100,000 ' + coin);
    if (accountNumber.trim().length < 5) throw new Error('Invalid account number');
    if (accountName.trim().length < 2) throw new Error('Invalid account holder name');

    var bals = {};
    try { bals = JSON.parse(localStorage.getItem('cw_balances') || '{}'); } catch(e) {}
    var available = bals[coin] || 0;
    if (coinAmount > available) throw new Error('Insufficient ' + coin + ' balance. Available: ' + available.toFixed(4));

    var price = COIN_PRICES[coin] || 0.50;
    var usdValue = coinAmount * price;
    var fee = usdValue * BANK_WITHDRAW_FEE_PCT;
    var netUsd = usdValue - fee;

    // Debit wallet balance (escrow — held until proof verified)
    bals[coin] = available - coinAmount;
    if (bals[coin] < 0.0001) bals[coin] = 0;
    localStorage.setItem('cw_balances', JSON.stringify(bals));

    var record = {
      id: 'bwd_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
      type: 'bank_withdraw',
      coin: coin,
      coinAmount: coinAmount,
      usdValue: usdValue,
      fee: fee,
      netUsd: netUsd,
      bankId: bankId,
      accountNumber: accountNumber.trim(),
      accountName: accountName.trim(),
      status: 'pending_proof',
      receiptCode: generateReceiptCode(),
      proofScreenshot: null,
      proofEnteredCode: '',
      proofNote: '',
      proofSubmittedAt: 0,
      proofVerifiedAt: 0,
      rejectReason: '',
      timestamp: Date.now(),
    };

    var history = getDWHistory();
    history.unshift(record);
    saveDWHistory(history);

    try {
      var acts = JSON.parse(localStorage.getItem('cw_activity') || '[]');
      acts.unshift({
        type: 'bank_withdraw',
        label: 'Bank withdrawal initiated ' + coinAmount.toFixed(2) + ' ' + coin + ' to ' + bankId + ' — awaiting proof',
        amount: '-' + coinAmount.toFixed(4) + ' ' + coin,
        ts: Date.now()
      });
      localStorage.setItem('cw_activity', JSON.stringify(acts));
    } catch(e) {}

    return record;
  }

  // ── Card Deposit & Withdraw ──────────────────────────────

  function getCardDepositHistory() {
    return getDWHistory().filter(function(r) { return r.type === 'card_deposit'; });
  }

  function getCardWithdrawHistory() {
    return getDWHistory().filter(function(r) { return r.type === 'card_withdraw'; });
  }

  /**
   * Deposit via card payment into wallet
   */
  function depositViaCard(coin, usdAmount, cardType, cardLast4, cardHolder) {
    if (!coin || !usdAmount || !cardType || !cardLast4 || !cardHolder) throw new Error('All fields are required');
    if (usdAmount < 5) throw new Error('Minimum card deposit is $5');
    if (usdAmount > 25000) throw new Error('Maximum card deposit is $25,000');
    if (cardLast4.trim().length !== 4 || !/^\d{4}$/.test(cardLast4.trim())) throw new Error('Invalid card last 4 digits');
    if (cardHolder.trim().length < 2) throw new Error('Invalid cardholder name');

    var price = COIN_PRICES[coin] || 0.50;
    var fee = usdAmount * CARD_DEPOSIT_FEE_PCT;
    var netUsd = usdAmount - fee;
    var coinsReceived = netUsd / price;

    var record = {
      id: 'cdep_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
      type: 'card_deposit',
      coin: coin,
      usdAmount: usdAmount,
      fee: fee,
      coinsReceived: coinsReceived,
      cardType: cardType,
      cardLast4: cardLast4.trim(),
      cardHolder: cardHolder.trim(),
      status: 'pending_proof',
      receiptCode: generateReceiptCode(),
      proofScreenshot: null,
      proofEnteredCode: '',
      proofNote: '',
      proofSubmittedAt: 0,
      proofVerifiedAt: 0,
      rejectReason: '',
      timestamp: Date.now(),
    };

    var history = getDWHistory();
    history.unshift(record);
    saveDWHistory(history);

    try {
      var acts = JSON.parse(localStorage.getItem('cw_activity') || '[]');
      acts.unshift({
        type: 'card_deposit',
        label: 'Card deposit initiated ' + coinsReceived.toFixed(2) + ' ' + coin + ' via ' + cardType + ' ****' + cardLast4 + ' — awaiting proof',
        amount: '+' + coinsReceived.toFixed(4) + ' ' + coin,
        ts: Date.now()
      });
      localStorage.setItem('cw_activity', JSON.stringify(acts));
    } catch(e) {}

    return record;
  }

  /**
   * Withdraw from wallet to card
   */
  function withdrawToCard(coin, coinAmount, cardType, cardLast4, cardHolder) {
    if (!coin || !coinAmount || !cardType || !cardLast4 || !cardHolder) throw new Error('All fields are required');
    if (coinAmount < 1) throw new Error('Minimum withdrawal is 1 ' + coin);
    if (coinAmount > 100000) throw new Error('Maximum withdrawal is 100,000 ' + coin);
    if (cardLast4.trim().length !== 4 || !/^\d{4}$/.test(cardLast4.trim())) throw new Error('Invalid card last 4 digits');
    if (cardHolder.trim().length < 2) throw new Error('Invalid cardholder name');

    var bals = {};
    try { bals = JSON.parse(localStorage.getItem('cw_balances') || '{}'); } catch(e) {}
    var available = bals[coin] || 0;
    if (coinAmount > available) throw new Error('Insufficient ' + coin + ' balance. Available: ' + available.toFixed(4));

    var price = COIN_PRICES[coin] || 0.50;
    var usdValue = coinAmount * price;
    var fee = usdValue * CARD_WITHDRAW_FEE_PCT;
    var netUsd = usdValue - fee;

    // Debit wallet immediately (escrow)
    bals[coin] = available - coinAmount;
    localStorage.setItem('cw_balances', JSON.stringify(bals));

    var record = {
      id: 'cwd_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
      type: 'card_withdraw',
      coin: coin,
      coinAmount: coinAmount,
      usdValue: usdValue,
      fee: fee,
      netUsd: netUsd,
      cardType: cardType,
      cardLast4: cardLast4.trim(),
      cardHolder: cardHolder.trim(),
      status: 'pending_proof',
      receiptCode: generateReceiptCode(),
      proofScreenshot: null,
      proofEnteredCode: '',
      proofNote: '',
      proofSubmittedAt: 0,
      proofVerifiedAt: 0,
      rejectReason: '',
      timestamp: Date.now(),
    };

    var history = getDWHistory();
    history.unshift(record);
    saveDWHistory(history);

    try {
      var acts = JSON.parse(localStorage.getItem('cw_activity') || '[]');
      acts.unshift({
        type: 'card_withdraw',
        label: 'Card withdrawal initiated ' + coinAmount.toFixed(2) + ' ' + coin + ' to ' + cardType + ' ****' + cardLast4 + ' — awaiting proof',
        amount: '-' + coinAmount.toFixed(4) + ' ' + coin,
        ts: Date.now()
      });
      localStorage.setItem('cw_activity', JSON.stringify(acts));
    } catch(e) {}

    return record;
  }

  // ── DW Proof Verification System ─────────────────────────

  var DW_PROOF_STATUS = {
    PENDING:   'pending_proof',
    SUBMITTED: 'proof_submitted',
    VERIFIED:  'confirmed',
    REJECTED:  'rejected',
  };

  function getDWRecord(id) {
    var all = getDWHistory();
    for (var i = 0; i < all.length; i++) {
      if (all[i].id === id) return all[i];
    }
    return null;
  }

  function updateDWRecord(record) {
    var all = getDWHistory();
    for (var i = 0; i < all.length; i++) {
      if (all[i].id === record.id) {
        all[i] = record;
        saveDWHistory(all);
        return;
      }
    }
  }

  /**
   * Submit proof for a deposit/withdraw transaction.
   * User uploads a screenshot and enters the receipt code from their SMS.
   * The entered code is compared to the system-generated receipt code.
   */
  function submitDWProof(recordId, screenshotDataUrl, enteredCode, note) {
    var rec = getDWRecord(recordId);
    if (!rec) throw new Error('Transaction not found');
    if (rec.status !== DW_PROOF_STATUS.PENDING && rec.status !== DW_PROOF_STATUS.REJECTED) {
      throw new Error('Proof already submitted or transaction already verified');
    }
    if (!screenshotDataUrl) throw new Error('Please upload a screenshot of your payment receipt');
    if (typeof screenshotDataUrl !== 'string' || screenshotDataUrl.indexOf('data:image/') !== 0) {
      throw new Error('Invalid screenshot format');
    }
    if (!enteredCode || enteredCode.trim().length < 3) {
      throw new Error('Enter the receipt code from your SMS / payment confirmation');
    }

    rec.proofScreenshot = screenshotDataUrl;
    rec.proofEnteredCode = enteredCode.trim();
    rec.proofNote = (note || '').trim();
    rec.proofSubmittedAt = Date.now();
    rec.rejectReason = '';
    rec.status = DW_PROOF_STATUS.SUBMITTED;
    updateDWRecord(rec);

    logActivity(
      'DW Proof Submitted',
      '\uD83D\uDCF8',
      rec.type + ' #' + rec.id + ' proof uploaded. Code entered: ' + enteredCode.trim(),
      (rec.coinsReceived ? '+' + rec.coinsReceived.toFixed(2) : '-' + rec.coinAmount.toFixed(2)) + ' ' + rec.coin,
      'blue'
    );

    return rec;
  }

  /**
   * Verify a DW transaction: checks entered receipt code matches the system code.
   * On match: credits wallet for deposits, finalizes withdrawals.
   * On mismatch: auto-rejects.
   */
  function verifyDWTransaction(recordId) {
    var rec = getDWRecord(recordId);
    if (!rec) throw new Error('Transaction not found');
    if (rec.status !== DW_PROOF_STATUS.SUBMITTED) {
      throw new Error('Transaction has no submitted proof to verify');
    }

    // Compare receipt codes (case-insensitive)
    var sysCode = (rec.receiptCode || '').trim().toUpperCase();
    var userCode = (rec.proofEnteredCode || '').trim().toUpperCase();
    if (sysCode !== userCode) {
      // Auto-reject on mismatch
      rec.status = DW_PROOF_STATUS.REJECTED;
      rec.rejectReason = 'Receipt code mismatch. Expected code from SMS does not match entered code.';

      // Refund wallet for withdrawals (escrowed balance)
      if (rec.type === 'withdraw' || rec.type === 'bank_withdraw' || rec.type === 'card_withdraw') {
        var bals = {};
        try { bals = JSON.parse(localStorage.getItem('cw_balances') || '{}'); } catch(e) {}
        bals[rec.coin] = (bals[rec.coin] || 0) + rec.coinAmount;
        localStorage.setItem('cw_balances', JSON.stringify(bals));
      }

      updateDWRecord(rec);
      throw new Error('Receipt code mismatch! The code you entered does not match. Check your SMS and try again.');
    }

    // Code matches — finalize transaction
    rec.status = DW_PROOF_STATUS.VERIFIED;
    rec.proofVerifiedAt = Date.now();

    // Credit wallet for deposits
    if (rec.type === 'deposit' || rec.type === 'bank_deposit' || rec.type === 'card_deposit') {
      var bals = {};
      try { bals = JSON.parse(localStorage.getItem('cw_balances') || '{}'); } catch(e) {}
      bals[rec.coin] = (bals[rec.coin] || 0) + rec.coinsReceived;
      localStorage.setItem('cw_balances', JSON.stringify(bals));
    }
    // Withdrawals: balance already debited at initiation — nothing more to do

    updateDWRecord(rec);

    var amtLabel = rec.coinsReceived
      ? '+' + rec.coinsReceived.toFixed(2) + ' ' + rec.coin
      : '-' + rec.coinAmount.toFixed(2) + ' ' + rec.coin;

    logActivity(
      'Transaction Verified',
      '\u2705',
      rec.type + ' #' + rec.id + ' verified. Receipt: ' + sysCode,
      amtLabel,
      'green'
    );

    return rec;
  }

  /**
   * Reject a DW proof (admin or auto-reject). For withdrawals, refunds the wallet.
   */
  function rejectDWProof(recordId, reason) {
    var rec = getDWRecord(recordId);
    if (!rec) throw new Error('Transaction not found');
    if (rec.status !== DW_PROOF_STATUS.SUBMITTED && rec.status !== DW_PROOF_STATUS.PENDING) {
      throw new Error('Cannot reject — transaction is ' + rec.status);
    }

    rec.status = DW_PROOF_STATUS.REJECTED;
    rec.rejectReason = (reason || 'Proof rejected').trim();

    // Refund wallet for withdrawals
    if (rec.type === 'withdraw' || rec.type === 'bank_withdraw' || rec.type === 'card_withdraw') {
      var bals = {};
      try { bals = JSON.parse(localStorage.getItem('cw_balances') || '{}'); } catch(e) {}
      bals[rec.coin] = (bals[rec.coin] || 0) + rec.coinAmount;
      localStorage.setItem('cw_balances', JSON.stringify(bals));
    }

    updateDWRecord(rec);

    logActivity(
      'DW Proof Rejected',
      '\u26A0\uFE0F',
      rec.type + ' #' + rec.id + ' — ' + rec.rejectReason,
      (rec.coinsReceived ? rec.coinsReceived.toFixed(2) : rec.coinAmount.toFixed(2)) + ' ' + rec.coin,
      'red'
    );

    return rec;
  }

  function getPendingDWTransactions() {
    return getDWHistory().filter(function(r) {
      return r.status === DW_PROOF_STATUS.PENDING || r.status === DW_PROOF_STATUS.SUBMITTED;
    });
  }

  // ── Public interface ───────────────────────────────────────

  return {
    // Config
    P2P_CONTRACT: P2P_CONTRACT,
    TOKEN_CONTRACT: TOKEN_CONTRACT,
    USDC_CONTRACT: USDC_CONTRACT,
    SIDE: SIDE,
    SIDE_LABEL: SIDE_LABEL,
    STATUS: STATUS,
    STATUS_LABEL: STATUS_LABEL,
    TOKEN_PRICE: TOKEN_PRICE,
    toStroops: toStroops,
    fromStroops: fromStroops,

    // On-chain write operations
    approveToken: approveToken,
    placeOrder: placeOrder,
    cancelOrder: cancelOrder,

    // On-chain read operations
    getOrder: getOrder,
    getTrade: getTrade,
    getBuyOrders: getBuyOrders,
    getSellOrders: getSellOrders,
    getUserOrders: getUserOrders,
    getUserTrades: getUserTrades,

    // Local/offline operations (testnet fallback)
    placeOrderLocal: placeOrderLocal,
    cancelOrderLocal: cancelOrderLocal,
    getLocalOrders: getLocalOrders,
    getLocalOrder: getLocalOrder,
    getLocalTrades: getLocalTrades,
    saveOrderLocal: saveOrderLocal,
    getOrderBookLocal: getOrderBookLocal,
    getMyOrdersLocal: getMyOrdersLocal,
    getMyTradesLocal: getMyTradesLocal,
    seedOrderBook: seedOrderBook,

    // Payment methods
    PAYMENT_METHODS: PAYMENT_METHODS,
    getPaymentLabel: getPaymentLabel,

    // Payment proof
    PROOF_STATUS: PROOF_STATUS,
    PROOF_LABEL: PROOF_LABEL,
    getLocalTrade: getLocalTrade,
    updateTradeLocal: updateTradeLocal,
    submitProof: submitProof,
    confirmProof: confirmProof,
    disputeProof: disputeProof,

    // Helpers
    isWalletConnected: isWalletConnected,
    getPublicKey: getPublicKey,

    // Deposit & Withdraw (Mobile)
    MOBILE_PROVIDERS: MOBILE_PROVIDERS,
    COIN_PRICES: COIN_PRICES,
    DEPOSIT_FEE_PCT: DEPOSIT_FEE_PCT,
    WITHDRAW_FEE_PCT: WITHDRAW_FEE_PCT,
    depositToWallet: depositToWallet,
    withdrawToSIM: withdrawToSIM,
    getDepositHistory: getDepositHistory,
    getWithdrawHistory: getWithdrawHistory,
    getDWHistory: getDWHistory,

    // Deposit & Withdraw (Bank)
    BANK_PROVIDERS: BANK_PROVIDERS,
    BANK_DEPOSIT_FEE_PCT: BANK_DEPOSIT_FEE_PCT,
    BANK_WITHDRAW_FEE_PCT: BANK_WITHDRAW_FEE_PCT,
    depositViaBank: depositViaBank,
    withdrawToBank: withdrawToBank,
    getBankDepositHistory: getBankDepositHistory,
    getBankWithdrawHistory: getBankWithdrawHistory,

    // Deposit & Withdraw (Card)
    CARD_PROVIDERS: CARD_PROVIDERS,
    CARD_DEPOSIT_FEE_PCT: CARD_DEPOSIT_FEE_PCT,
    CARD_WITHDRAW_FEE_PCT: CARD_WITHDRAW_FEE_PCT,
    depositViaCard: depositViaCard,
    withdrawToCard: withdrawToCard,
    getCardDepositHistory: getCardDepositHistory,
    getCardWithdrawHistory: getCardWithdrawHistory,

    // DW Proof Verification
    DW_PROOF_STATUS: DW_PROOF_STATUS,
    getDWRecord: getDWRecord,
    updateDWRecord: updateDWRecord,
    submitDWProof: submitDWProof,
    verifyDWTransaction: verifyDWTransaction,
    rejectDWProof: rejectDWProof,
    getPendingDWTransactions: getPendingDWTransactions,
  };
})();

// ═══════════════════════════════════════════════════════════════
//  P2P API CLIENT — Connects frontend to p2p-api-server.py
//  Wraps all P2P payment operations with real HTTP API calls.
//  Falls back to localStorage methods if API server is offline.
// ═══════════════════════════════════════════════════════════════

var P2P_API = (function() {
  'use strict';

  // ── Config ─────────────────────────────────────────────────
  var API_BASE = window.P2P_API_URL || 'http://localhost:5000/api/p2p';
  var _online = null; // null = unknown, true/false after first check

  // ── Helpers ────────────────────────────────────────────────

  function _getUserId() {
    try {
      var u = JSON.parse(localStorage.getItem('cw_user') || 'null');
      if (u && (u.addr || u.email || u.name)) return u.addr || u.email || u.name;
    } catch(e) {}
    return '';
  }

  function _request(method, path, body) {
    return new Promise(function(resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open(method, API_BASE + path, true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.timeout = 15000;
      xhr.onload = function() {
        try {
          var data = JSON.parse(xhr.responseText);
          if (xhr.status >= 200 && xhr.status < 300 && data.success) {
            resolve(data);
          } else {
            reject(new Error(data.error || ('HTTP ' + xhr.status)));
          }
        } catch(e) {
          reject(new Error('Invalid server response'));
        }
      };
      xhr.onerror = function() { reject(new Error('Network error — API server may be offline')); };
      xhr.ontimeout = function() { reject(new Error('Request timed out')); };
      if (body) {
        xhr.send(JSON.stringify(body));
      } else {
        xhr.send();
      }
    });
  }

  function _syncLocalBalance(serverBals) {
    if (!serverBals) return;
    var local = {};
    try { local = JSON.parse(localStorage.getItem('cw_balances') || '{}'); } catch(e) {}
    for (var coin in serverBals) {
      local[coin] = serverBals[coin];
    }
    localStorage.setItem('cw_balances', JSON.stringify(local));
  }

  function _syncLocalRecord(record) {
    if (!record || !record.id) return;
    try {
      var history = JSON.parse(localStorage.getItem('cw_p2p_dw_history') || '[]');
      var found = false;
      for (var i = 0; i < history.length; i++) {
        if (history[i].id === record.id) {
          history[i] = record;
          found = true;
          break;
        }
      }
      if (!found) history.unshift(record);
      localStorage.setItem('cw_p2p_dw_history', JSON.stringify(history));
    } catch(e) {}
  }

  // ── Health Check ───────────────────────────────────────────

  function checkHealth() {
    return _request('GET', '/health').then(function(data) {
      _online = true;
      return true;
    }).catch(function() {
      _online = false;
      return false;
    });
  }

  function isOnline() {
    return _online === true;
  }

  // ── Balance Sync ───────────────────────────────────────────

  function syncBalance() {
    var userId = _getUserId();
    if (!userId) return Promise.reject(new Error('Not logged in'));
    var local = {};
    try { local = JSON.parse(localStorage.getItem('cw_balances') || '{}'); } catch(e) {}
    return _request('POST', '/balance/sync', {
      userId: userId,
      balances: local
    }).then(function(data) {
      _syncLocalBalance(data.balances);
      return data.balances;
    });
  }

  function getBalance() {
    var userId = _getUserId();
    if (!userId) return Promise.reject(new Error('Not logged in'));
    return _request('GET', '/balance?userId=' + encodeURIComponent(userId)).then(function(data) {
      _syncLocalBalance(data.balances);
      return data.balances;
    });
  }

  // ── Deposit: Mobile ────────────────────────────────────────

  function depositMobile(coin, usdAmount, provider, phone) {
    return _request('POST', '/deposit/mobile', {
      userId: _getUserId(),
      coin: coin,
      usdAmount: usdAmount,
      provider: provider,
      phone: phone
    }).then(function(data) {
      _syncLocalRecord(data.transaction);
      return data.transaction;
    });
  }

  // ── Deposit: Bank ──────────────────────────────────────────

  function depositBank(coin, usdAmount, bankId, accountNumber, accountName) {
    return _request('POST', '/deposit/bank', {
      userId: _getUserId(),
      coin: coin,
      usdAmount: usdAmount,
      bankId: bankId,
      accountNumber: accountNumber,
      accountName: accountName
    }).then(function(data) {
      _syncLocalRecord(data.transaction);
      return data.transaction;
    });
  }

  // ── Deposit: Card ──────────────────────────────────────────

  function depositCard(coin, usdAmount, cardType, cardLast4, cardHolder) {
    return _request('POST', '/deposit/card', {
      userId: _getUserId(),
      coin: coin,
      usdAmount: usdAmount,
      cardType: cardType,
      cardLast4: cardLast4,
      cardHolder: cardHolder
    }).then(function(data) {
      _syncLocalRecord(data.transaction);
      return data.transaction;
    });
  }

  // ── Withdraw: Mobile ───────────────────────────────────────

  function withdrawMobile(coin, coinAmount, provider, phone) {
    return _request('POST', '/withdraw/mobile', {
      userId: _getUserId(),
      coin: coin,
      coinAmount: coinAmount,
      provider: provider,
      phone: phone
    }).then(function(data) {
      _syncLocalRecord(data.transaction);
      _syncLocalBalance(null); // will be updated via getBalance
      return data.transaction;
    });
  }

  // ── Withdraw: Bank ─────────────────────────────────────────

  function withdrawBank(coin, coinAmount, bankId, accountNumber, accountName) {
    return _request('POST', '/withdraw/bank', {
      userId: _getUserId(),
      coin: coin,
      coinAmount: coinAmount,
      bankId: bankId,
      accountNumber: accountNumber,
      accountName: accountName
    }).then(function(data) {
      _syncLocalRecord(data.transaction);
      return data.transaction;
    });
  }

  // ── Withdraw: Card ─────────────────────────────────────────

  function withdrawCard(coin, coinAmount, cardType, cardLast4, cardHolder) {
    return _request('POST', '/withdraw/card', {
      userId: _getUserId(),
      coin: coin,
      coinAmount: coinAmount,
      cardType: cardType,
      cardLast4: cardLast4,
      cardHolder: cardHolder
    }).then(function(data) {
      _syncLocalRecord(data.transaction);
      return data.transaction;
    });
  }

  // ── Proof Submission ───────────────────────────────────────

  function submitProof(recordId, screenshot, enteredCode, note) {
    return _request('POST', '/proof/submit', {
      recordId: recordId,
      screenshot: screenshot,
      enteredCode: enteredCode,
      note: note || ''
    }).then(function(data) {
      _syncLocalRecord(data.transaction);
      return data.transaction;
    });
  }

  // ── Proof Verification ─────────────────────────────────────

  function verifyProof(recordId) {
    return _request('POST', '/proof/verify', {
      recordId: recordId
    }).then(function(data) {
      _syncLocalRecord(data.transaction);
      // Refresh balance after verification
      getBalance().catch(function() {});
      return data.transaction;
    });
  }

  // ── Proof Rejection ────────────────────────────────────────

  function rejectProof(recordId, reason) {
    return _request('POST', '/proof/reject', {
      recordId: recordId,
      reason: reason || ''
    }).then(function(data) {
      _syncLocalRecord(data.transaction);
      getBalance().catch(function() {});
      return data.transaction;
    });
  }

  // ── Get Transaction ────────────────────────────────────────

  function getTransaction(txId) {
    return _request('GET', '/transaction/' + encodeURIComponent(txId)).then(function(data) {
      return data.transaction;
    });
  }

  // ── Get User Transactions ──────────────────────────────────

  function getTransactions(type, limit) {
    var userId = _getUserId();
    var url = '/transactions?userId=' + encodeURIComponent(userId);
    if (type) url += '&type=' + encodeURIComponent(type);
    if (limit) url += '&limit=' + limit;
    return _request('GET', url).then(function(data) {
      return data.transactions;
    });
  }

  // ── Get Pending Transactions ───────────────────────────────

  function getPending() {
    var userId = _getUserId();
    return _request('GET', '/pending?userId=' + encodeURIComponent(userId)).then(function(data) {
      return data.transactions;
    });
  }

  // ── Get Prices & Providers ─────────────────────────────────

  function getPrices() {
    return _request('GET', '/prices').then(function(data) {
      return data;
    });
  }

  function getProviders() {
    return _request('GET', '/providers').then(function(data) {
      return data;
    });
  }

  // ── Public API ─────────────────────────────────────────────

  return {
    API_BASE: API_BASE,
    checkHealth: checkHealth,
    isOnline: isOnline,

    // Balance
    syncBalance: syncBalance,
    getBalance: getBalance,

    // Deposits
    depositMobile: depositMobile,
    depositBank: depositBank,
    depositCard: depositCard,

    // Withdrawals
    withdrawMobile: withdrawMobile,
    withdrawBank: withdrawBank,
    withdrawCard: withdrawCard,

    // Proof system
    submitProof: submitProof,
    verifyProof: verifyProof,
    rejectProof: rejectProof,

    // Queries
    getTransaction: getTransaction,
    getTransactions: getTransactions,
    getPending: getPending,
    getPrices: getPrices,
    getProviders: getProviders,
  };
})();
