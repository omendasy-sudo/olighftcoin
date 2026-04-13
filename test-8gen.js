#!/usr/bin/env node
/**
 * OLIGHFT SMART COIN — 8-Generation Commission Flow Test
 * 
 * Tests the full 8-gen sponsor chain on the card_staking contract:
 *   1. Create 9 wallets (admin + 8 generation sponsors)
 *   2. Fund all via Friendbot  
 *   3. Initialize card_staking contract (admin)
 *   4. Set Visa card config with 8-gen commission rates
 *   5. Register sponsor chain: gen1→admin, gen2→gen1, ... gen8→gen7
 *   6. Mint OLIGHFT tokens to gen8 (the staker)
 *   7. Gen8 activates a Visa stake → commissions distribute up 8 gens  
 *   8. Verify each generation received the correct commission
 */
const sdk = require('@stellar/stellar-sdk');
const bip39 = require('bip39');
const { derivePath } = require('ed25519-hd-key');
const { Keypair, Contract, TransactionBuilder, Address, nativeToScVal, xdr } = sdk;
const { Server } = sdk.rpc;

const TOKEN_ID    = 'CA5NW2ZJISLPTRRPEFY7XIKSB5CZ5XF2PIARJL2F37H7EPRAXXD34W6J';
const CARD_STK_ID = 'CANTB5ENAFHLN2CWRFA5JFTXNXIR2DZZF4RXY6644BOSWCHQOWPVDB3V';
const RPC_URL     = 'https://soroban-testnet.stellar.org';
const PASS        = 'Test SDF Network ; September 2015';

// 8-gen commission rates in basis points (contract-side rates)
const COMMISSION_BPS = [1000, 500, 250, 125, 100, 75, 50, 25];
// Visa tier config
const VISA_MIN_STAKE = 100n * 10000000n;  // 100 OLIGHFT in stroops
const VISA_LOCK_DAYS = 30;
const VISA_APY_BPS   = 2400;  // 24%
const VISA_MAX_STAKES = 10;
const STAKE_AMOUNT   = 100n * 10000000n;  // 100 OLIGHFT

function getAdmin() {
  const mnemonic = 'myth reopen hood derive bundle dove guard noise wave broccoli tattoo humor paper during bicycle wish endorse rotate stool salon river real target clarify';
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  const { key } = derivePath("m/44'/148'/0'", seed.toString('hex'));
  return Keypair.fromRawEd25519Seed(key);
}

async function fundAccount(pub) {
  const r = await fetch('https://friendbot.stellar.org?addr=' + pub);
  return (await r.json()).successful !== false;
}

async function submitTx(server, kp, ops, fee = '500000') {
  const account = await server.getAccount(kp.publicKey());
  const builder = new TransactionBuilder(account, { fee, networkPassphrase: PASS }).setTimeout(180);
  if (Array.isArray(ops)) { ops.forEach(op => builder.addOperation(op)); }
  else { builder.addOperation(ops); }
  const tx = builder.build();
  const sim = await server.simulateTransaction(tx);
  if (sdk.rpc.Api.isSimulationError(sim)) throw new Error('Sim fail: ' + (sim.error || JSON.stringify(sim)));
  const prepared = sdk.rpc.assembleTransaction(tx, sim).build();
  prepared.sign(kp);
  const sr = await server.sendTransaction(prepared);
  if (sr.status === 'ERROR') throw new Error('Submit rejected: ' + JSON.stringify(sr));
  // Poll
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const gr = await server.getTransaction(sr.hash);
    if (gr.status === 'SUCCESS') return gr;
    if (gr.status === 'FAILED') throw new Error('TX failed on-chain: ' + sr.hash);
  }
  throw new Error('TX timeout: ' + sr.hash);
}

async function getBalance(server, tokenContract, who, sourceKp) {
  const account = await server.getAccount(sourceKp.publicKey());
  const tx = new TransactionBuilder(account, { fee: '100', networkPassphrase: PASS })
    .addOperation(tokenContract.call('balance', new Address(who).toScVal()))
    .setTimeout(30).build();
  const sim = await server.simulateTransaction(tx);
  if (!sim.result) return 0n;
  return BigInt(sdk.scValToNative(sim.result.retval));
}

async function main() {
  const server = new Server(RPC_URL);
  const tokenContract = new Contract(TOKEN_ID);
  const cardContract  = new Contract(CARD_STK_ID);
  const admin = getAdmin();

  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║   OLIGHFT 8-GENERATION COMMISSION FLOW TEST             ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('Admin:', admin.publicKey());

  // ── Step 1: Create 8 generation wallets ──
  console.log('\n[1/8] Creating 8 generation wallets...');
  const gens = [];
  for (let i = 0; i < 8; i++) {
    gens.push(Keypair.random());
    console.log(`   Gen${i+1}: ${gens[i].publicKey()}`);
  }

  // ── Step 2: Fund all accounts ──
  console.log('\n[2/8] Funding all accounts via Friendbot...');
  const fundPromises = gens.map((g, i) => 
    fundAccount(g.publicKey()).then(ok => console.log(`   Gen${i+1}: ${ok ? 'OK' : 'FAIL'}`))
  );
  await Promise.all(fundPromises);

  // ── Step 3: Initialize card_staking contract ──
  console.log('\n[3/8] Initializing card_staking contract...');
  try {
    await submitTx(server, admin, cardContract.call('initialize',
      nativeToScVal(admin.publicKey(), { type: 'address' }),
      nativeToScVal(TOKEN_ID, { type: 'address' })
    ));
    console.log('   Initialized OK');
  } catch (e) {
    if (e.message.includes('AlreadyInitialized') || e.message.includes('Sim fail')) {
      console.log('   Already initialized (OK)');
    } else {
      console.log('   Init error:', e.message.slice(0, 120));
    }
  }

  // ── Step 4: Set Visa card config with 8-gen commission BPS ──
  console.log('\n[4/8] Setting Visa card config (8-gen commissions)...');
  // Build commission_bps as Vec<u32>
  const bpsVec = COMMISSION_BPS.map(bp => nativeToScVal(bp, { type: 'u32' }));
  const commBpsScVal = xdr.ScVal.scvVec(bpsVec);
  try {
    await submitTx(server, admin, cardContract.call('set_card_config',
      nativeToScVal(0, { type: 'u32' }),           // tier: Visa = 0
      nativeToScVal(VISA_MIN_STAKE, { type: 'i128' }),  // min_stake
      nativeToScVal(VISA_LOCK_DAYS, { type: 'u32' }),   // lock_days
      nativeToScVal(VISA_APY_BPS, { type: 'u32' }),     // apy_bps
      nativeToScVal(VISA_MAX_STAKES, { type: 'u32' }),  // max_stakes
      commBpsScVal                                       // commission_bps [8 vals]
    ));
    console.log('   Config set: Visa tier, APY 24%, Commission BPS:', COMMISSION_BPS.join(', '));
  } catch (e) {
    console.log('   Config error:', e.message.slice(0, 200));
  }

  // ── Step 5: Register sponsor chain ──
  // gen1's sponsor = admin, gen2's sponsor = gen1, ... gen8's sponsor = gen7
  console.log('\n[5/8] Registering 8-gen sponsor chain...');
  const chain = [admin, ...gens.slice(0, 7)]; // sponsors for gen1..gen8
  for (let i = 0; i < 8; i++) {
    const user = gens[i];
    const sponsor = chain[i];
    try {
      await submitTx(server, user, cardContract.call('register_sponsor',
        nativeToScVal(user.publicKey(), { type: 'address' }),
        nativeToScVal(sponsor.publicKey(), { type: 'address' })
      ));
      console.log(`   Gen${i+1} → sponsor: ${i === 0 ? 'Admin' : 'Gen'+i} ✓`);
    } catch (e) {
      console.log(`   Gen${i+1} sponsor error:`, e.message.slice(0, 120));
    }
  }

  // ── Step 6: Mint OLIGHFT to gen8 (the staker) + fund contract ──
  console.log('\n[6/8] Minting OLIGHFT tokens...');
  const staker = gens[7]; // gen8 is the staker
  const mintAmount = 500n * 10000000n; // 500 OLIGHFT
  const contractFund = 200n * 10000000n; // 200 OLIGHFT for commission payouts
  
  // Transfer from admin (who has ~99M OLIGHFT) to gen8
  try {
    await submitTx(server, admin, tokenContract.call('transfer',
      nativeToScVal(admin.publicKey(), { type: 'address' }),
      nativeToScVal(staker.publicKey(), { type: 'address' }),
      nativeToScVal(mintAmount, { type: 'i128' })
    ));
    console.log(`   Sent 500 OLIGHFT to Gen8 (staker)`);
  } catch (e) {
    console.log('   Transfer to gen8 error:', e.message.slice(0, 120));
  }

  // Fund the card_staking contract so it can pay commissions
  try {
    await submitTx(server, admin, tokenContract.call('transfer',
      nativeToScVal(admin.publicKey(), { type: 'address' }),
      nativeToScVal(CARD_STK_ID, { type: 'address' }),
      nativeToScVal(contractFund, { type: 'i128' })
    ));
    console.log(`   Sent 200 OLIGHFT to card_staking contract (commission reserves)`);
  } catch (e) {
    console.log('   Contract funding error:', e.message.slice(0, 120));
  }

  // ── Snapshot balances BEFORE stake ──
  console.log('\n   Snapshotting balances before stake...');
  const before = {};
  before['admin'] = await getBalance(server, tokenContract, admin.publicKey(), admin);
  for (let i = 0; i < 8; i++) {
    before[`gen${i+1}`] = await getBalance(server, tokenContract, gens[i].publicKey(), admin);
  }
  before['contract'] = await getBalance(server, tokenContract, CARD_STK_ID, admin);

  console.log(`   Admin:    ${Number(before['admin']) / 1e7}`);
  console.log(`   Gen8:     ${Number(before['gen8']) / 1e7}`);
  console.log(`   Contract: ${Number(before['contract']) / 1e7}`);

  // ── Step 7: Gen8 activates Visa stake → triggers 8-gen commissions ──
  console.log('\n[7/8] Gen8 activating 100 OLIGHFT Visa stake...');
  try {
    // Gen8 must approve the token transfer to card_staking - done implicitly by Soroban
    const result = await submitTx(server, staker, cardContract.call('activate_stake',
      nativeToScVal(staker.publicKey(), { type: 'address' }),
      nativeToScVal(0, { type: 'u32' }),               // tier: Visa = 0
      nativeToScVal(STAKE_AMOUNT, { type: 'i128' })     // 100 OLIGHFT
    ));
    console.log('   Stake activated! TX confirmed ✓');
  } catch (e) {
    console.log('   STAKE FAILED:', e.message.slice(0, 300));
    console.log('\n   Cannot proceed without successful stake. Exiting.');
    return;
  }

  // ── Step 8: Verify commissions received ──
  console.log('\n[8/8] Verifying 8-generation commission distribution...');
  console.log('─'.repeat(62));
  console.log('   Gen | Rate   | Expected OLIGHFT | Received      | Status');
  console.log('─'.repeat(62));

  let allPass = true;
  const stakeOlighft = Number(STAKE_AMOUNT) / 1e7;

  // Commission walks UP from staker: gen8→gen7→gen6→...→gen1→admin
  // So gen7 = generation 1 (direct sponsor), gen6 = gen 2, ... admin = gen 8
  const verifyOrder = [
    { label: 'Gen7', key: 'gen7', desc: '(direct sponsor of staker)' },
    { label: 'Gen6', key: 'gen6', desc: '' },
    { label: 'Gen5', key: 'gen5', desc: '' },
    { label: 'Gen4', key: 'gen4', desc: '' },
    { label: 'Gen3', key: 'gen3', desc: '' },
    { label: 'Gen2', key: 'gen2', desc: '' },
    { label: 'Gen1', key: 'gen1', desc: '' },
    { label: 'Admin', key: 'admin', desc: '(root of tree)' },
  ];
  const walletMap = {
    'admin': admin,
    'gen1': gens[0], 'gen2': gens[1], 'gen3': gens[2], 'gen4': gens[3],
    'gen5': gens[4], 'gen6': gens[5], 'gen7': gens[6],
  };

  for (let i = 0; i < 8; i++) {
    const v = verifyOrder[i];
    const wallet = walletMap[v.key];
    const after = await getBalance(server, tokenContract, wallet.publicKey(), admin);
    const diff = Number(after - before[v.key]) / 1e7;
    const expectedBps = COMMISSION_BPS[i];
    const expected = stakeOlighft * expectedBps / 10000;
    const pass = Math.abs(diff - expected) < 0.01;
    
    if (!pass) allPass = false;
    const genLabel = `G${i+1}`;
    console.log(`   ${genLabel.padEnd(4)} ${v.label.padEnd(6)}| ${(expectedBps/100).toFixed(2).padStart(5)}% | ${expected.toFixed(4).padStart(16)} | ${diff.toFixed(4).padStart(13)} | ${pass ? '✅ PASS' : '❌ FAIL'} ${v.desc}`);
  }

  console.log('─'.repeat(62));

  // Verify gen8 (staker) balance decreased by stake amount
  const gen8After = await getBalance(server, tokenContract, staker.publicKey(), admin);
  const gen8Diff = Number(before['gen8'] - gen8After) / 1e7;
  console.log(`\n   Gen8 (staker) spent: ${gen8Diff.toFixed(4)} OLIGHFT (expected: ${stakeOlighft})`);

  // Contract balance check
  const contractAfter = await getBalance(server, tokenContract, CARD_STK_ID, admin);
  const totalComm = COMMISSION_BPS.reduce((sum, bp) => sum + stakeOlighft * bp / 10000, 0);
  console.log(`   Contract reserves: ${Number(contractAfter) / 1e7} OLIGHFT`);
  console.log(`   Total commissions paid: ${totalComm.toFixed(4)} OLIGHFT (${(totalComm/stakeOlighft*100).toFixed(2)}% of stake)`);

  console.log('\n' + (allPass ? '╔══════════════════════════════════════╗' : '╔══════════════════════════════════════╗'));
  console.log(allPass  ? '║   ✅ ALL 8-GEN COMMISSIONS PASSED    ║' : '║   ❌ SOME COMMISSIONS FAILED         ║');
  console.log(allPass  ? '╚══════════════════════════════════════╝' : '╚══════════════════════════════════════╝');
}

main().catch(e => console.error('FATAL:', e.message || e));
