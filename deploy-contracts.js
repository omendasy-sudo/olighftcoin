#!/usr/bin/env node
/**
 * OLIGHFT Smart Coin — Soroban Contract Deployer
 * Deploys WASM contracts to Stellar Testnet using the JS SDK
 */
const fs = require('fs');
const path = require('path');
const bip39 = require('bip39');
const { derivePath } = require('ed25519-hd-key');
const {
  Keypair,
  TransactionBuilder,
  Networks,
  Operation,
  Account,
  xdr,
  hash,
  StrKey,
  Address,
  rpc,
  contract,
} = require('@stellar/stellar-sdk');

const SOROBAN_RPC = 'https://soroban-testnet.stellar.org';
const NETWORK_PASSPHRASE = Networks.TESTNET;
const WASM_DIR = 'D:\\cargo-target\\wasm32-unknown-unknown\\release';

// Contracts to deploy (name -> wasm filename)
const CONTRACTS_TO_DEPLOY = {
  'swap_amm': 'olighft_swap_amm.wasm',
  'payment': 'olighft_payment.wasm',
  'escrow': 'olighft_escrow.wasm',
};

// Already deployed - skip these
const ALREADY_DEPLOYED = {
  'token': 'CA5NW2ZJISLPTRRPEFY7XIKSB5CZ5XF2PIARJL2F37H7EPRAXXD34W6J',
  'staking': 'CA5QKLZKEY2X6WTYHCBV4LYYTVXQT7L2WAJGLBWXXZAYC5XFHN3MF6HU',
  'card_staking': 'CANTB5ENAFHLN2CWRFA5JFTXNXIR2DZZF4RXY6644BOSWCHQOWPVDB3V',
  'p2p': 'CD4YLF3UF7OCWI776UUYB2TQUJCVORIEHHQ7OE3CZT2G6CCKE7JUM77N',
  'invite': 'CBUWWTHKBOW5WBYDXT2IRB6LZHHXHUR4Y2I6NC4CLK7CHSQAANGJVAIH',
};

async function getAdminKeypair() {
  const mnemonic = 'myth reopen hood derive bundle dove guard noise wave broccoli tattoo humor paper during bicycle wish endorse rotate stool salon river real target clarify';
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  const { key } = derivePath("m/44'/148'/0'", seed.toString('hex'));
  return Keypair.fromRawEd25519Seed(key);
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForTx(server, txHash, label) {
  for (let i = 0; i < 30; i++) {
    await sleep(3000);
    const status = await server.getTransaction(txHash);
    console.log(`  ${label} status: ${status.status}`);
    if (status.status === 'SUCCESS' || status.status === 'FAILED' || status.status === 'ERROR') {
      return status;
    }
  }
  throw new Error(`${label} timed out after 90s`);
}

async function submitWithRetry(server, adminKp, buildTxFn, label, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const account = await server.getAccount(adminKp.publicKey());
      const tx = buildTxFn(account);
      const prepared = await server.prepareTransaction(tx);
      prepared.sign(adminKp);
      const result = await server.sendTransaction(prepared);
      console.log(`${label} submitted: ${result.hash} (status: ${result.status})`);

      if (result.status === 'PENDING') {
        return await waitForTx(server, result.hash, label);
      } else if (result.status === 'TRY_AGAIN_LATER') {
        console.log(`  Rate limited, waiting 10s before retry ${attempt}/${maxRetries}...`);
        await sleep(10000);
        continue;
      } else if (result.status === 'ERROR') {
        console.error(`${label} error:`, JSON.stringify(result.errorResult || result, null, 2));
        if (attempt < maxRetries) {
          console.log(`  Retrying in 5s (${attempt}/${maxRetries})...`);
          await sleep(5000);
          continue;
        }
        return result;
      }
      return result;
    } catch (e) {
      console.error(`  ${label} attempt ${attempt} exception: ${e.message}`);
      if (attempt < maxRetries) {
        await sleep(5000);
        continue;
      }
      throw e;
    }
  }
}

function extractContractId(txResult) {
  // Try multiple paths to extract the contract ID
  try {
    // Path 1: resultMetaXdr.v3().sorobanMeta().returnValue()
    const meta = txResult.resultMetaXdr;
    if (meta && typeof meta.v3 === 'function') {
      const v3 = meta.v3();
      if (v3 && v3.sorobanMeta) {
        const retVal = v3.sorobanMeta().returnValue();
        return Address.fromScVal(retVal).toString();
      }
    }
  } catch (e) { /* try next */ }

  try {
    // Path 2: returnValue directly on txResult
    if (txResult.returnValue) {
      return Address.fromScVal(txResult.returnValue).toString();
    }
  } catch (e) { /* try next */ }

  try {
    // Path 3: resultXdr
    if (txResult.resultXdr) {
      const results = txResult.resultXdr.result().results();
      if (results && results.length > 0) {
        const innerResult = results[0].tr().invokeHostFunctionResult().success();
        return Address.fromScVal(innerResult).toString();
      }
    }
  } catch (e) { /* try next */ }

  // Path 4: Check transaction meta for contract creation events
  try {
    if (txResult.resultMetaXdr) {
      const changes = txResult.resultMetaXdr.v3 
        ? txResult.resultMetaXdr.v3().operations()[0].changes()
        : [];
      for (const change of changes) {
        if (change.switch().name === 'ledgerEntryCreated') {
          const data = change.created().data();
          if (data.switch().name === 'contractData') {
            const contractData = data.contractData();
            const addr = contractData.contract();
            return StrKey.encodeContract(addr.contractId());
          }
        }
      }
    }
  } catch (e) { /* give up */ }

  console.error('Could not extract contract ID from result. Raw keys:', Object.keys(txResult));
  return null;
}

async function deployContract(server, adminKp, wasmPath, contractName) {
  console.log(`\n=== Deploying ${contractName} ===`);
  console.log(`WASM: ${wasmPath}`);

  const wasmCode = fs.readFileSync(wasmPath);
  console.log(`WASM size: ${wasmCode.length} bytes`);

  // Step 1: Upload WASM
  console.log('Step 1: Uploading WASM...');
  const uploadResult = await submitWithRetry(server, adminKp, (account) => {
    return new TransactionBuilder(account, {
      fee: '10000000',
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(Operation.uploadContractWasm({ wasm: wasmCode }))
      .setTimeout(300)
      .build();
  }, `${contractName}/upload`);

  if (!uploadResult || uploadResult.status !== 'SUCCESS') {
    console.error(`Upload failed for ${contractName}`);
    return null;
  }

  const wasmHash = hash(wasmCode);
  console.log(`WASM hash: ${wasmHash.toString('hex')}`);

  // Wait a bit between upload and create to avoid rate limiting
  await sleep(5000);

  // Step 2: Create contract instance
  console.log('Step 2: Creating contract instance...');
  const createResult = await submitWithRetry(server, adminKp, (account) => {
    return new TransactionBuilder(account, {
      fee: '10000000',
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(Operation.createCustomContract({
        address: new Address(adminKp.publicKey()),
        wasmHash: wasmHash,
      }))
      .setTimeout(300)
      .build();
  }, `${contractName}/create`);

  if (!createResult || createResult.status !== 'SUCCESS') {
    console.error(`Create failed for ${contractName}`);
    return null;
  }

  const contractId = extractContractId(createResult);
  if (contractId) {
    console.log(`✓ Contract deployed: ${contractId}`);
  } else {
    console.log(`✓ Contract created but could not extract ID. Check tx: ${createResult.hash || 'unknown'}`);
  }

  // Wait between contract deployments
  await sleep(5000);

  return contractId;
}

async function main() {
  console.log('OLIGHFT Smart Coin — Contract Deployment');
  console.log('Network: Stellar Testnet');
  console.log('========================================');

  const adminKp = await getAdminKeypair();
  console.log(`Admin account: ${adminKp.publicKey()}`);

  const expected = 'GBLEKKQNHKVE7NIOOPY7CQ6SJ4BQCGHD3O5FCPB2B47X2ERKSJGSMWCP';
  if (adminKp.publicKey() !== expected) {
    console.error(`Admin key mismatch! Expected ${expected}, got ${adminKp.publicKey()}`);
    process.exit(1);
  }
  console.log('Admin key verified ✓');

  const server = new rpc.Server(SOROBAN_RPC);

  // Check account balance
  try {
    const account = await server.getAccount(adminKp.publicKey());
    console.log(`Account sequence: ${account.sequenceNumber()}`);
  } catch (e) {
    console.error('Cannot access admin account:', e.message);
    console.log('Funding via friendbot...');
    const fetch = globalThis.fetch || (await import('node-fetch')).default;
    await fetch(`https://friendbot.stellar.org?addr=${adminKp.publicKey()}`);
    await sleep(5000);
  }

  const results = {};

  // Deploy each contract
  for (const [name, wasmFile] of Object.entries(CONTRACTS_TO_DEPLOY)) {
    const wasmPath = path.join(WASM_DIR, wasmFile);
    if (!fs.existsSync(wasmPath)) {
      console.error(`WASM not found: ${wasmPath}`);
      results[name] = 'MISSING';
      continue;
    }

    try {
      const contractId = await deployContract(server, adminKp, wasmPath, name);
      results[name] = contractId || 'FAILED';
    } catch (e) {
      console.error(`Error deploying ${name}:`, e.message);
      results[name] = `ERROR: ${e.message}`;
    }
  }

  // Summary
  console.log('\n========================================');
  console.log('DEPLOYMENT SUMMARY');
  console.log('========================================');
  console.log('\nAlready deployed:');
  for (const [name, id] of Object.entries(ALREADY_DEPLOYED)) {
    console.log(`  ${name}: ${id}`);
  }
  console.log('\nNewly deployed:');
  for (const [name, id] of Object.entries(results)) {
    console.log(`  ${name}: ${id}`);
  }

  // Save results
  const allContracts = { ...ALREADY_DEPLOYED, ...results };
  fs.writeFileSync('deployed-contracts.json', JSON.stringify(allContracts, null, 2));
  console.log('\nResults saved to deployed-contracts.json');
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
