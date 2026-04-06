use clap::Args;
use colored::Colorize;
use std::fs;
use std::io::{self, BufRead, Write};

use crate::util;

#[derive(Args)]
pub struct SandboxArgs {
    /// Port for the local Soroban RPC endpoint (default: 8000)
    #[arg(short, long, default_value_t = 8000)]
    pub port: u16,

    /// Automatically deploy all contracts after sandbox starts
    #[arg(long)]
    pub auto_deploy: bool,

    /// Number of test accounts to fund via friendbot (1-10)
    #[arg(long, default_value_t = 3)]
    pub accounts: u8,

    /// Run full interactive REPL after setup
    #[arg(long)]
    pub repl: bool,

    /// Ledger advancement interval in seconds (simulates block time)
    #[arg(long, default_value_t = 5)]
    pub ledger_interval: u32,
}

pub fn run(args: SandboxArgs, workspace: &str, verbose: bool) -> Result<(), String> {
    let root = util::resolve_workspace(workspace);
    let soroban = resolve_cli()?;

    util::header("OLIGHFT Local Sandbox");
    println!("  mode     : {}", "local (identical to on-chain)".green());
    println!("  rpc      : http://localhost:{}", args.port);
    println!("  accounts : {}", args.accounts);
    println!("  ledger Δ : {}s", args.ledger_interval);
    println!();

    // ── 1. Start local network ─────────────────────────────────────
    util::step("starting local Soroban network…");

    let network_name = "olighft-sandbox";
    let rpc_url = format!("http://localhost:{}", args.port);

    // Configure the local network identity
    let _ = util::exec_output(
        &soroban,
        &[
            "network",
            "add",
            network_name,
            "--rpc-url",
            &rpc_url,
            "--network-passphrase",
            "Standalone Network ; February 2017",
        ],
        &root,
    );

    // Start the standalone node (background)
    util::step("launching standalone node (this may take a moment)…");
    let port_str = args.port.to_string();
    // We launch in the background and give it a moment
    let _child = std::process::Command::new(&soroban)
        .args(["sandbox", "start", "--port", &port_str])
        .current_dir(&root)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .or_else(|_| {
            // Fallback: newer stellar CLI uses `stellar container start`
            std::process::Command::new(&soroban)
                .args([
                    "container",
                    "start",
                    "standalone",
                    "--port",
                    &port_str,
                ])
                .current_dir(&root)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
        })
        .map_err(|e| format!("cannot start sandbox: {}", e))?;

    // Brief wait for RPC readiness
    util::step("waiting for RPC to become ready…");
    wait_for_rpc(&rpc_url, 30)?;
    util::ok("local RPC is live");

    // ── 2. Create and fund test accounts ───────────────────────────
    let accounts = create_test_accounts(&soroban, &root, args.accounts, verbose)?;

    // ── 3. Auto-deploy contracts ───────────────────────────────────
    let mut contract_ids: Vec<(String, String)> = Vec::new();

    if args.auto_deploy {
        util::step("building contracts…");
        let build_args = crate::build::BuildArgs {
            contract: None,
            profile: "release".into(),
            optimize: false,
            soroban_optimize: false,
        };
        crate::build::run(build_args, workspace, verbose)?;

        util::step("deploying all contracts to sandbox…");

        for crate_name in util::CONTRACT_CRATES {
            let package = format!("olighft-{}", crate_name.replace('_', "-"));
            let wasm_dir = util::wasm_out_dir(&root);
            let wasm_file = wasm_dir.join(util::wasm_filename(&package));

            if !wasm_file.exists() {
                util::warn(&format!("no WASM for {}, skipping", crate_name));
                continue;
            }

            let wasm_str = wasm_file.to_string_lossy().to_string();
            let source = &accounts[0];

            match util::exec_output(
                &soroban,
                &[
                    "contract",
                    "deploy",
                    "--wasm",
                    &wasm_str,
                    "--source",
                    source,
                    "--network",
                    network_name,
                ],
                &root,
            ) {
                Ok(id) => {
                    util::ok(&format!("{} → {}", crate_name, id.green()));
                    contract_ids.push((crate_name.to_string(), id));
                }
                Err(e) => {
                    util::warn(&format!("{} deploy failed: {}", crate_name, e));
                }
            }
        }

        // Write sandbox manifest
        write_sandbox_manifest(&root, &contract_ids, &accounts)?;
    }

    // ── 4. Summary ─────────────────────────────────────────────────
    println!();
    util::header("Sandbox Ready");
    println!("  {} {}", "RPC".bold(), rpc_url.cyan());
    println!();

    if !accounts.is_empty() {
        println!("  {}:", "Test Accounts".bold());
        for (i, acc) in accounts.iter().enumerate() {
            println!("    [{}] {}", i, acc.cyan());
        }
        println!();
    }

    if !contract_ids.is_empty() {
        println!("  {}:", "Deployed Contracts".bold());
        for (name, id) in &contract_ids {
            println!("    {:16} {}", name, id.green());
        }
        println!();
    }

    println!("  {} invoke example:", "→".cyan());
    if let Some((name, id)) = contract_ids.first() {
        println!(
            "    {} contract invoke --id {} --source {} --network {} -- --fn <function>",
            soroban, id, accounts[0], network_name
        );
    } else {
        println!(
            "    {} contract invoke --id <ID> --source <ACCOUNT> --network {} -- --fn <function>",
            soroban, network_name
        );
    }

    // ── 5. Optional REPL ───────────────────────────────────────────
    if args.repl {
        println!();
        repl(&soroban, &root, network_name, &accounts, &contract_ids, verbose)?;
    } else {
        println!();
        println!("  Press {} to stop the sandbox.", "Ctrl+C".bold());
        // Block until interrupted
        let _ = std::io::stdin().lock().read_line(&mut String::new());
    }

    Ok(())
}

fn resolve_cli() -> Result<String, String> {
    if util::require_tool("stellar").is_ok() {
        Ok("stellar".into())
    } else if util::require_tool("soroban").is_ok() {
        Ok("soroban".into())
    } else {
        Err("neither `stellar` nor `soroban` CLI found on PATH".into())
    }
}

fn wait_for_rpc(url: &str, timeout_secs: u32) -> Result<(), String> {
    let health_url = format!("{}/health", url.trim_end_matches('/'));
    let start = std::time::Instant::now();
    loop {
        if start.elapsed().as_secs() > timeout_secs as u64 {
            return Err(format!("RPC at {} did not become ready within {}s", url, timeout_secs));
        }

        // Try a simple TCP connection
        let addr = url
            .trim_start_matches("http://")
            .trim_start_matches("https://");
        // Resolve hostname (e.g. "localhost:8000") to SocketAddr via ToSocketAddrs
        use std::net::ToSocketAddrs;
        let sock_addr = addr
            .to_socket_addrs()
            .ok()
            .and_then(|mut addrs| addrs.next())
            .unwrap_or_else(|| std::net::SocketAddr::from(([127, 0, 0, 1], 8000)));
        if let Ok(_stream) = std::net::TcpStream::connect_timeout(
            &sock_addr,
            std::time::Duration::from_secs(1),
        ) {
            return Ok(());
        }

        std::thread::sleep(std::time::Duration::from_millis(500));
    }
}

fn create_test_accounts(
    soroban: &str,
    root: &std::path::Path,
    count: u8,
    verbose: bool,
) -> Result<Vec<String>, String> {
    let count = count.min(10);
    let mut accounts = Vec::new();

    util::step(&format!("generating {} test accounts…", count));

    for i in 0..count {
        let name = format!("test-account-{}", i);

        // Generate a new identity
        let _ = util::exec_output(
            soroban,
            &["keys", "generate", &name, "--network", "olighft-sandbox"],
            root,
        );

        // Get the public key
        match util::exec_output(soroban, &["keys", "address", &name], root) {
            Ok(addr) => {
                util::ok(&format!("account {} → {}", i, addr.chars().take(16).collect::<String>()));
                accounts.push(name);
            }
            Err(e) => {
                if verbose {
                    util::warn(&format!("account {} generation failed: {}", i, e));
                }
            }
        }
    }

    Ok(accounts)
}

fn write_sandbox_manifest(
    root: &std::path::Path,
    contracts: &[(String, String)],
    accounts: &[String],
) -> Result<(), String> {
    let manifest = serde_json::json!({
        "network": "olighft-sandbox",
        "created_at": chrono::Utc::now().to_rfc3339(),
        "accounts": accounts,
        "contracts": contracts.iter().map(|(name, id)| {
            serde_json::json!({"contract": name, "id": id})
        }).collect::<Vec<_>>(),
    });

    let path = root.join("sandbox-manifest.json");
    fs::write(&path, serde_json::to_string_pretty(&manifest).unwrap())
        .map_err(|e| format!("cannot write sandbox manifest: {}", e))?;
    util::ok(&format!("sandbox manifest → {}", path.display()));
    Ok(())
}

/// Minimal interactive REPL for invoking contract functions.
fn repl(
    soroban: &str,
    root: &std::path::Path,
    network: &str,
    accounts: &[String],
    contracts: &[(String, String)],
    verbose: bool,
) -> Result<(), String> {
    util::header("OLIGHFT Sandbox REPL");
    println!("  Commands:");
    println!("    invoke <contract> <function> [args...]  — call a contract function");
    println!("    accounts                                — list test accounts");
    println!("    contracts                               — list deployed contracts");
    println!("    ledger                                  — show current ledger sequence");
    println!("    help                                    — show this help");
    println!("    quit / exit                             — stop sandbox");
    println!();

    let stdin = io::stdin();
    loop {
        print!("{} ", "olighft>".green().bold());
        io::stdout().flush().unwrap();

        let mut line = String::new();
        if stdin.lock().read_line(&mut line).is_err() || line.is_empty() {
            break;
        }

        let parts: Vec<&str> = line.trim().split_whitespace().collect();
        if parts.is_empty() {
            continue;
        }

        match parts[0] {
            "quit" | "exit" => {
                println!("  shutting down…");
                break;
            }
            "help" | "?" => {
                println!("  invoke <contract> <function> [args...]");
                println!("  accounts | contracts | ledger | quit");
            }
            "accounts" => {
                for (i, a) in accounts.iter().enumerate() {
                    println!("  [{}] {}", i, a);
                }
            }
            "contracts" => {
                for (name, id) in contracts {
                    println!("  {:16} {}", name, id);
                }
            }
            "invoke" => {
                if parts.len() < 3 {
                    println!("  usage: invoke <contract> <function> [args...]");
                    continue;
                }
                let contract_name = parts[1];
                let func = parts[2];

                // Resolve contract ID
                let contract_id = contracts
                    .iter()
                    .find(|(n, _)| n == contract_name)
                    .map(|(_, id)| id.clone());

                let id = match contract_id {
                    Some(id) => id,
                    None => {
                        println!("  unknown contract `{}`", contract_name);
                        continue;
                    }
                };

                let source = accounts.first().map(|s| s.as_str()).unwrap_or("default");

                let mut invoke_args = vec![
                    "contract",
                    "invoke",
                    "--id",
                    &id,
                    "--source",
                    source,
                    "--network",
                    network,
                    "--",
                    "--fn",
                    func,
                ];

                // Forward remaining args as --arg pairs
                for chunk in parts[3..].chunks(2) {
                    for part in chunk {
                        invoke_args.push(part);
                    }
                }

                match util::exec_output(soroban, &invoke_args, root) {
                    Ok(output) => println!("  {}", output.green()),
                    Err(e) => println!("  {} {}", "error:".red(), e),
                }
            }
            "ledger" => {
                // Query ledger via soroban
                match util::exec_output(
                    soroban,
                    &["events", "--network", network, "--count", "1"],
                    root,
                ) {
                    Ok(output) => println!("  {}", output),
                    Err(_) => println!("  (could not query ledger)"),
                }
            }
            _ => {
                println!("  unknown command `{}`. Type `help`.", parts[0]);
            }
        }
    }

    Ok(())
}
