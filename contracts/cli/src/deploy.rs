use clap::Args;
use colored::Colorize;
use sha2::{Sha256, Digest};
use std::fs;

use crate::util;

#[derive(Args)]
pub struct DeployArgs {
    /// Contract to deploy (omit to deploy all in dependency order)
    #[arg(short, long)]
    pub contract: Option<String>,

    /// Target network: local | testnet | mainnet
    #[arg(short, long, default_value = "testnet")]
    pub network: String,

    /// Source account identity (Soroban identity name or secret key)
    #[arg(short, long, default_value = "default")]
    pub source: String,

    /// Skip build step (assume WASM is already compiled)
    #[arg(long)]
    pub no_build: bool,

    /// Dry-run: print commands without executing
    #[arg(long)]
    pub dry_run: bool,
}

/// Deploy order — dependencies first (token before staking, etc.)
const DEPLOY_ORDER: &[&str] = &[
    "token",
    "invite",
    "staking",
    "card_staking",
    "swap_amm",
    "payment",
];

pub fn run(args: DeployArgs, workspace: &str, verbose: bool) -> Result<(), String> {
    let root = util::resolve_workspace(workspace);

    // Resolve soroban/stellar CLI
    let soroban = resolve_cli()?;

    let network = validate_network(&args.network)?;

    let contracts: Vec<&str> = match &args.contract {
        Some(name) => {
            if !util::CONTRACT_CRATES.contains(&name.as_str()) {
                return Err(format!(
                    "unknown contract `{}`. Available: {}",
                    name,
                    util::CONTRACT_CRATES.join(", ")
                ));
            }
            vec![name.as_str()]
        }
        None => DEPLOY_ORDER.to_vec(),
    };

    util::header(&format!("Deploying to {}", network.cyan()));

    if network == "mainnet" {
        println!(
            "  {} deploying to {} — double-check source identity!",
            "⚠".yellow(),
            "MAINNET".red().bold()
        );
    }

    // Optional build step
    if !args.no_build {
        util::step("building contracts before deploy…");
        let build_args = crate::build::BuildArgs {
            contract: args.contract.clone(),
            profile: "release".into(),
            optimize: true,
            soroban_optimize: false,
        };
        crate::build::run(build_args, workspace, verbose)?;
    }

    let mut deployed: Vec<(&str, String)> = Vec::new();

    for crate_name in &contracts {
        let package = format!("olighft-{}", crate_name.replace('_', "-"));
        let wasm_dir = util::wasm_out_dir(&root);
        let wasm_file = wasm_dir.join(util::wasm_filename(&package));

        if !wasm_file.exists() {
            return Err(format!(
                "WASM not found for `{}`. Build first.",
                crate_name
            ));
        }

        // Compute hash for logging
        let bytes = fs::read(&wasm_file)
            .map_err(|e| format!("cannot read wasm: {}", e))?;
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        let hash = hex::encode(hasher.finalize());

        let wasm_str = wasm_file.to_string_lossy().to_string();

        util::step(&format!(
            "deploying {} ({}, sha256:{}…)",
            crate_name.cyan(),
            util::human_bytes(bytes.len() as u64),
            &hash[..12]
        ));

        if args.dry_run {
            println!(
                "  {} {} contract deploy --wasm {} --source {} --network {}",
                "[dry-run]".yellow(),
                soroban,
                wasm_str,
                args.source,
                network
            );
            deployed.push((crate_name, "DRY_RUN".into()));
            continue;
        }

        // Deploy and capture the contract ID
        let contract_id = util::exec_output(
            &soroban,
            &[
                "contract",
                "deploy",
                "--wasm",
                &wasm_str,
                "--source",
                &args.source,
                "--network",
                &network,
            ],
            &root,
        )?;

        util::ok(&format!("{} → {}", crate_name, contract_id.green()));
        deployed.push((crate_name, contract_id));
    }

    // Summary
    println!();
    util::header("Deployment Summary");
    println!("  {:16} {}", "CONTRACT".bold(), "ID".bold());
    for (name, id) in &deployed {
        println!("  {:16} {}", name, id.cyan());
    }

    // Write deployment manifest
    let manifest = build_manifest(&deployed, &network, &args.source);
    let manifest_path = root.join(format!("deploy-{}.json", network));
    fs::write(&manifest_path, manifest)
        .map_err(|e| format!("cannot write manifest: {}", e))?;
    util::ok(&format!("manifest → {}", manifest_path.display()));

    println!();
    Ok(())
}

fn resolve_cli() -> Result<String, String> {
    if util::require_tool("stellar").is_ok() {
        Ok("stellar".into())
    } else if util::require_tool("soroban").is_ok() {
        Ok("soroban".into())
    } else {
        Err("neither `stellar` nor `soroban` CLI found on PATH. Install with: cargo install --locked stellar-cli".into())
    }
}

fn validate_network(network: &str) -> Result<String, String> {
    match network {
        "local" | "testnet" | "mainnet" => Ok(network.to_string()),
        // Also accept full RPC URLs
        url if url.starts_with("http") => Ok(url.to_string()),
        _ => Err(format!(
            "invalid network `{}`. Use: local | testnet | mainnet | <RPC URL>",
            network
        )),
    }
}

fn build_manifest(deployed: &[(&str, String)], network: &str, source: &str) -> String {
    let entries: Vec<serde_json::Value> = deployed
        .iter()
        .map(|(name, id)| {
            serde_json::json!({
                "contract": name,
                "id": id,
            })
        })
        .collect();

    let manifest = serde_json::json!({
        "network": network,
        "source": source,
        "deployed_at": chrono::Utc::now().to_rfc3339(),
        "contracts": entries,
    });

    serde_json::to_string_pretty(&manifest).unwrap()
}
