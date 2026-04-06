use clap::Args;
use colored::Colorize;
use std::fs;

use crate::util;

#[derive(Args)]
pub struct BuildArgs {
    /// Contract to build (omit to build all)
    #[arg(short, long)]
    pub contract: Option<String>,

    /// Build profile: release (default) or release-with-logs
    #[arg(short, long, default_value = "release")]
    pub profile: String,

    /// Run wasm-opt on the output (if available)
    #[arg(long)]
    pub optimize: bool,

    /// Also run `soroban contract optimize` (if available)
    #[arg(long)]
    pub soroban_optimize: bool,
}

pub fn run(args: BuildArgs, workspace: &str, verbose: bool) -> Result<(), String> {
    let root = util::resolve_workspace(workspace);
    util::require_tool("cargo")?;

    let contracts = match &args.contract {
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
        None => util::CONTRACT_CRATES.to_vec(),
    };

    util::header("Building contracts");

    for crate_name in &contracts {
        util::step(&format!("compiling {}", crate_name.cyan()));

        let package = format!("olighft-{}", crate_name.replace('_', "-"));

        let mut cargo_args = vec![
            "build",
            "--target",
            util::WASM_TARGET,
            "--profile",
            &args.profile,
            "-p",
        ];
        cargo_args.push(&package);

        util::exec("cargo", &cargo_args, &root, verbose)?;

        // Report artifact size
        let wasm_dir = util::wasm_out_dir(&root);
        let wasm_file = wasm_dir.join(util::wasm_filename(&package));
        if wasm_file.exists() {
            let meta = fs::metadata(&wasm_file)
                .map_err(|e| format!("cannot stat wasm: {}", e))?;
            util::ok(&format!(
                "{} → {} ({})",
                crate_name,
                wasm_file.file_name().unwrap().to_string_lossy(),
                util::human_bytes(meta.len())
            ));
        }

        // Optional wasm-opt pass
        if args.optimize {
            if util::require_tool("wasm-opt").is_ok() {
                util::step(&format!("wasm-opt {}", crate_name));
                let wasm_str = wasm_file.to_string_lossy().to_string();
                util::exec(
                    "wasm-opt",
                    &["-Oz", &wasm_str, "-o", &wasm_str],
                    &root,
                    verbose,
                )?;
                let meta = fs::metadata(&wasm_file)
                    .map_err(|e| format!("cannot stat wasm: {}", e))?;
                util::ok(&format!(
                    "optimised → {}",
                    util::human_bytes(meta.len())
                ));
            } else {
                util::warn("wasm-opt not found, skipping optimisation");
            }
        }

        // Optional soroban optimize pass
        if args.soroban_optimize {
            let soroban = if util::require_tool("stellar").is_ok() {
                "stellar"
            } else if util::require_tool("soroban").is_ok() {
                "soroban"
            } else {
                util::warn("neither `stellar` nor `soroban` CLI found, skipping soroban optimize");
                continue;
            };

            util::step(&format!("{} contract optimize {}", soroban, crate_name));
            let wasm_str = wasm_file.to_string_lossy().to_string();
            util::exec(
                soroban,
                &["contract", "optimize", "--wasm", &wasm_str],
                &root,
                verbose,
            )?;
            let meta = fs::metadata(&wasm_file)
                .map_err(|e| format!("cannot stat wasm: {}", e))?;
            util::ok(&format!(
                "soroban optimised → {}",
                util::human_bytes(meta.len())
            ));
        }
    }

    println!();
    util::ok(&format!("built {} contract(s)", contracts.len()));
    Ok(())
}
