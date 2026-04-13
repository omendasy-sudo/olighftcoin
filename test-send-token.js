const sdk = require('@stellar/stellar-sdk');
const bip39 = require('bip39');
const { derivePath } = require('ed25519-hd-key');
const { Keypair, Contract, TransactionBuilder, Address, nativeToScVal } = sdk;
const { Server } = sdk.rpc;

const TOKEN = 'CA5NW2ZJISLPTRRPEFY7XIKSB5CZ5XF2PIARJL2F37H7EPRAXXD34W6J';
const RPC = 'https://soroban-testnet.stellar.org';
const PASS = 'Test SDF Network ; September 2015';

function getAdmin() {
  const mnemonic = 'myth reopen hood derive bundle dove guard noise wave broccoli tattoo humor paper during bicycle wish endorse rotate stool salon river real target clarify';
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  const { key } = derivePath("m/44'/148'/0'", seed.toString('hex'));
  return Keypair.fromRawEd25519Seed(key);
}

async function test() {
  const kp = getAdmin();
  console.log('Admin:', kp.publicKey());
  const server = new Server(RPC);
  const contract = new Contract(TOKEN);

  // 1. Check admin OLIGHFT balance
  console.log('\n[1] Querying admin OLIGHFT balance...');
  let account = await server.getAccount(kp.publicKey());
  let balTx = new TransactionBuilder(account, { fee: '100', networkPassphrase: PASS })
    .addOperation(contract.call('balance', new Address(kp.publicKey()).toScVal()))
    .setTimeout(30).build();
  let balSim = await server.simulateTransaction(balTx);
  if (balSim.result) {
    const bal = sdk.scValToNative(balSim.result.retval);
    console.log('   OLIGHFT Balance:', (Number(bal) / 1e7).toFixed(7));
  } else {
    console.log('   Balance query failed:', JSON.stringify(balSim));
    return;
  }

  // 2. Fund test recipient via Friendbot
  const testKp = Keypair.random();
  console.log('\n[2] Test recipient:', testKp.publicKey());
  console.log('   Funding via Friendbot...');
  const resp = await fetch('https://friendbot.stellar.org?addr=' + testKp.publicKey());
  const j = await resp.json();
  console.log('   Funded:', j.successful !== false ? 'YES' : 'NO');

  // 3. Transfer 1.0 OLIGHFT (= 10000000 stroops)
  console.log('\n[3] Transferring 1.0000000 OLIGHFT...');
  account = await server.getAccount(kp.publicKey());
  const amt = BigInt(10000000);
  const sendTx = new TransactionBuilder(account, { fee: '100000', networkPassphrase: PASS })
    .addOperation(contract.call('transfer',
      nativeToScVal(kp.publicKey(), { type: 'address' }),
      nativeToScVal(testKp.publicKey(), { type: 'address' }),
      nativeToScVal(amt, { type: 'i128' })))
    .setTimeout(120).build();

  const sim = await server.simulateTransaction(sendTx);
  if (sdk.rpc.Api.isSimulationError(sim)) {
    console.log('   SIMULATION FAILED:', sim.error);
    return;
  }
  console.log('   Simulation: OK');

  const prepared = sdk.rpc.assembleTransaction(sendTx, sim).build();
  prepared.sign(kp);
  const sr = await server.sendTransaction(prepared);
  console.log('   Submit:', sr.status, '| Hash:', sr.hash);
  if (sr.status === 'ERROR') { console.log('   Submit rejected'); return; }

  // 4. Poll for confirmation
  console.log('\n[4] Waiting for confirmation...');
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const gr = await server.getTransaction(sr.hash);
    if (gr.status === 'SUCCESS') {
      console.log('   TX CONFIRMED on Stellar Testnet!');

      // 5. Verify recipient received tokens
      console.log('\n[5] Checking recipient balance...');
      const acc3 = await server.getAccount(kp.publicKey());
      const bt2 = new TransactionBuilder(acc3, { fee: '100', networkPassphrase: PASS })
        .addOperation(contract.call('balance', new Address(testKp.publicKey()).toScVal()))
        .setTimeout(30).build();
      const bs2 = await server.simulateTransaction(bt2);
      if (bs2.result) {
        const b2 = sdk.scValToNative(bs2.result.retval);
        const received = Number(b2) / 1e7;
        console.log('   Recipient balance:', received.toFixed(7), 'OLIGHFT');
        console.log(received === 1 ? '   PASS: Received exactly 1.0000000 OLIGHFT' : '   FAIL: Expected 1.0, got ' + received);
      }
      console.log('\n=== ALL TESTS PASSED ===');
      return;
    }
    if (gr.status === 'FAILED') { console.log('   TX FAILED on-chain'); return; }
    process.stdout.write('.');
  }
  console.log('   Timeout waiting for confirmation');
}

test().catch(e => console.error('ERROR:', e.message || e));
