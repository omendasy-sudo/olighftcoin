use crate::util;
use colored::Colorize;
use std::fs;

/// Print resolved workspace configuration.
pub fn run(workspace: &str, _verbose: bool) -> Result<(), String> {
    let root = util::resolve_workspace(workspace);

    util::header("OLIGHFT Workspace Configuration");

    println!("  workspace : {}", root.display().to_string().cyan());

    // Read workspace Cargo.toml
    let cargo_path = root.join("Cargo.toml");
    if cargo_path.exists() {
        let content = fs::read_to_string(&cargo_path)
            .map_err(|e| format!("cannot read Cargo.toml: {}", e))?;
        let doc: toml::Value = content
            .parse()
            .map_err(|e| format!("invalid Cargo.toml: {}", e))?;

        // members
        if let Some(members) = doc
            .get("workspace")
            .and_then(|w| w.get("members"))
            .and_then(|m| m.as_array())
        {
            println!("  members   : {}", members.len());
            for m in members {
                if let Some(name) = m.as_str() {
                    let dir = root.join(name);
                    let status = if dir.join("src").exists() {
                        "✓".green().to_string()
                    } else {
                        "✗".red().to_string()
                    };
                    println!("    {} {}", status, name);
                }
            }
        }

        // soroban-sdk version
        if let Some(ver) = doc
            .get("workspace")
            .and_then(|w| w.get("dependencies"))
            .and_then(|d| d.get("soroban-sdk"))
            .and_then(|s| s.as_str())
        {
            println!("  soroban   : {}", ver.yellow());
        }
    } else {
        util::warn("Cargo.toml not found at workspace root");
    }

    // WASM output dir
    let wasm_dir = util::wasm_out_dir(&root);
    if wasm_dir.exists() {
        let wasm_files: Vec<_> = fs::read_dir(&wasm_dir)
            .map_err(|e| format!("cannot read wasm dir: {}", e))?
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.path()
                    .extension()
                    .map_or(false, |ext| ext == "wasm")
            })
            .collect();
        println!("  artifacts : {} .wasm file(s) in target/", wasm_files.len());
        for f in &wasm_files {
            let meta = f.metadata().ok();
            let size = meta.map(|m| util::human_bytes(m.len())).unwrap_or_default();
            println!(
                "    {} ({})",
                f.file_name().to_string_lossy(),
                size
            );
        }
    } else {
        println!("  artifacts : {} (run `olighft build` first)", "none".dimmed());
    }

    // Tool availability
    println!();
    util::header("Toolchain");
    for tool in &["cargo", "soroban", "stellar", "wasm-opt"] {
        match util::require_tool(tool) {
            Ok(p) => println!("  {} {} ({})", "✓".green(), tool, p.display()),
            Err(_) => println!("  {} {} {}", "✗".red(), tool, "not found".dimmed()),
        }
    }

    println!();
    Ok(())
}
