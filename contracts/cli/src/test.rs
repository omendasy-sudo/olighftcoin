use clap::Args;
use colored::Colorize;

use crate::util;

#[derive(Args)]
pub struct TestArgs {
    /// Contract to test (omit to test all)
    #[arg(short, long)]
    pub contract: Option<String>,

    /// Additional args forwarded to `cargo test` (e.g. `-- --nocapture`)
    #[arg(last = true)]
    pub extra: Vec<String>,

    /// Run tests with the release-with-logs profile for debug assertions
    #[arg(long)]
    pub with_logs: bool,

    /// Filter: only run tests matching this name substring
    #[arg(short, long)]
    pub filter: Option<String>,
}

pub fn run(args: TestArgs, workspace: &str, verbose: bool) -> Result<(), String> {
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

    util::header("Running contract tests");

    let mut pass = 0u32;
    let mut fail = 0u32;

    for crate_name in &contracts {
        util::step(&format!("testing {}", crate_name.cyan()));

        let package = format!("olighft-{}", crate_name.replace('_', "-"));

        let mut cargo_args: Vec<String> = vec![
            "test".into(),
            "-p".into(),
            package.clone(),
        ];

        if args.with_logs {
            cargo_args.push("--profile".into());
            cargo_args.push("release-with-logs".into());
        }

        // Test name filter
        if let Some(ref f) = args.filter {
            cargo_args.push(f.clone());
        }

        // Separator + extra args
        if !args.extra.is_empty() {
            cargo_args.push("--".into());
            cargo_args.extend(args.extra.iter().cloned());
        }

        let arg_refs: Vec<&str> = cargo_args.iter().map(|s| s.as_str()).collect();

        match util::exec("cargo", &arg_refs, &root, verbose) {
            Ok(()) => {
                util::ok(&format!("{} passed", crate_name));
                pass += 1;
            }
            Err(e) => {
                eprintln!("  {} {} failed: {}", "✗".red(), crate_name, e);
                fail += 1;
            }
        }
    }

    println!();
    if fail == 0 {
        util::ok(&format!(
            "all {} contract(s) passed",
            pass
        ));
        Ok(())
    } else {
        Err(format!(
            "{} passed, {} failed",
            pass, fail
        ))
    }
}
