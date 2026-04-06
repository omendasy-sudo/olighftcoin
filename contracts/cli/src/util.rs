use std::path::{Path, PathBuf};
use std::process::Command;
use colored::Colorize;

/// All workspace contract crate names (directory names under contracts/).
pub const CONTRACT_CRATES: &[&str] = &[
    "token",
    "staking",
    "card_staking",
    "swap_amm",
    "payment",
    "invite",
];

/// The WASM target triple for Soroban contracts.
pub const WASM_TARGET: &str = "wasm32-unknown-unknown";

/// Resolve the workspace root, normalising ".".
pub fn resolve_workspace(workspace: &str) -> PathBuf {
    let p = Path::new(workspace);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(p)
    }
}

/// Locate the `target/wasm32-unknown-unknown/release/` directory.
pub fn wasm_out_dir(workspace: &Path) -> PathBuf {
    workspace
        .join("target")
        .join(WASM_TARGET)
        .join("release")
}

/// Build a WASM filename from a crate name, e.g. `olighft_token.wasm`.
pub fn wasm_filename(crate_name: &str) -> String {
    // Cargo replaces hyphens with underscores in output filenames.
    format!("{}.wasm", crate_name.replace('-', "_"))
}

/// Pretty-print a step.
pub fn step(msg: &str) {
    println!("  {} {}", "→".cyan(), msg);
}

/// Pretty-print a success.
pub fn ok(msg: &str) {
    println!("  {} {}", "✓".green(), msg);
}

/// Pretty-print a warning.
pub fn warn(msg: &str) {
    println!("  {} {}", "⚠".yellow(), msg);
}

/// Pretty-print a section header.
pub fn header(title: &str) {
    println!("\n{}", title.bold().underline());
}

/// Run an external command, streaming stdout/stderr, returning success.
pub fn exec(program: &str, args: &[&str], cwd: &Path, verbose: bool) -> Result<(), String> {
    if verbose {
        println!("  {} {} {}", "$".dimmed(), program, args.join(" "));
    }

    let status = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .status()
        .map_err(|e| format!("failed to run `{}`: {}", program, e))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "`{} {}` exited with code {}",
            program,
            args.join(" "),
            status.code().unwrap_or(-1)
        ))
    }
}

/// Run an external command and capture stdout.
pub fn exec_output(program: &str, args: &[&str], cwd: &Path) -> Result<String, String> {
    let output = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("failed to run `{}`: {}", program, e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("`{} {}` failed: {}", program, args.join(" "), stderr))
    }
}

/// Check that a required tool is on PATH.
pub fn require_tool(name: &str) -> Result<PathBuf, String> {
    which::which(name).map_err(|_| {
        format!(
            "`{}` not found on PATH. Please install it first.",
            name
        )
    })
}

/// Format a byte count as a human-readable size.
pub fn human_bytes(bytes: u64) -> String {
    if bytes < 1024 {
        format!("{} B", bytes)
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KiB", bytes as f64 / 1024.0)
    } else {
        format!("{:.2} MiB", bytes as f64 / (1024.0 * 1024.0))
    }
}
