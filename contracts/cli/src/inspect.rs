use clap::Args;
use colored::Colorize;
use sha2::{Sha256, Digest};
use std::fs;

use crate::util;

#[derive(Args)]
pub struct InspectArgs {
    /// Contract to inspect (must be built first)
    #[arg(short, long)]
    pub contract: String,

    /// Also run `soroban contract inspect` for full ABI detail
    #[arg(long)]
    pub abi: bool,

    /// Output raw JSON (for piping)
    #[arg(long)]
    pub json: bool,
}

/// Minimal WASM section parser — reads custom/export sections.
struct WasmInfo {
    pub size: u64,
    pub sha256: String,
    pub exports: Vec<WasmExport>,
    pub custom_sections: Vec<String>,
}

struct WasmExport {
    pub name: String,
    pub kind: &'static str,
}

pub fn run(args: InspectArgs, workspace: &str, verbose: bool) -> Result<(), String> {
    let root = util::resolve_workspace(workspace);
    let package = format!("olighft-{}", args.contract.replace('_', "-"));
    let wasm_dir = util::wasm_out_dir(&root);
    let wasm_file = wasm_dir.join(util::wasm_filename(&package));

    if !wasm_file.exists() {
        return Err(format!(
            "WASM not found at {}. Run `olighft build -c {}` first.",
            wasm_file.display(),
            args.contract
        ));
    }

    let bytes = fs::read(&wasm_file)
        .map_err(|e| format!("cannot read wasm: {}", e))?;

    let info = parse_wasm(&bytes)?;

    if args.json {
        print_json(&args.contract, &wasm_file.to_string_lossy(), &info);
        return Ok(());
    }

    util::header(&format!("Inspecting: {}", args.contract));

    println!("  file    : {}", wasm_file.display().to_string().cyan());
    println!("  size    : {}", util::human_bytes(info.size));
    println!("  sha256  : {}", info.sha256.dimmed());

    // Exports
    println!();
    println!("  {} ({}):", "exports".bold(), info.exports.len());
    for exp in &info.exports {
        let badge = match exp.kind {
            "func" => "fn".green(),
            "memory" => "mem".blue(),
            "table" => "tbl".yellow(),
            "global" => "glb".magenta(),
            _ => exp.kind.normal(),
        };
        println!("    [{}] {}", badge, exp.name);
    }

    // Custom sections
    if !info.custom_sections.is_empty() {
        println!();
        println!("  {} ({}):", "custom sections".bold(), info.custom_sections.len());
        for s in &info.custom_sections {
            println!("    {}", s);
        }
    }

    // Optional soroban inspect for full ABI
    if args.abi {
        println!();
        let soroban = if util::require_tool("stellar").is_ok() {
            "stellar"
        } else if util::require_tool("soroban").is_ok() {
            "soroban"
        } else {
            util::warn("neither `stellar` nor `soroban` CLI found");
            return Ok(());
        };

        util::step(&format!("{} contract inspect", soroban));
        let wasm_str = wasm_file.to_string_lossy().to_string();
        let output = util::exec_output(
            soroban,
            &["contract", "inspect", "--wasm", &wasm_str],
            &root,
        )?;
        println!("{}", output);
    }

    println!();
    Ok(())
}

fn parse_wasm(bytes: &[u8]) -> Result<WasmInfo, String> {
    // Validate magic + version
    if bytes.len() < 8 || &bytes[0..4] != b"\0asm" {
        return Err("not a valid WASM file".into());
    }

    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let hash = hex::encode(hasher.finalize());

    let mut exports = Vec::new();
    let mut custom_sections = Vec::new();
    let mut pos = 8; // skip magic + version

    while pos < bytes.len() {
        if pos + 1 > bytes.len() {
            break;
        }
        let section_id = bytes[pos];
        pos += 1;

        let (section_len, adv) = read_leb128(&bytes[pos..])?;
        pos += adv;

        let section_end = pos + section_len as usize;
        if section_end > bytes.len() {
            break;
        }

        match section_id {
            // Export section
            7 => {
                let mut p = pos;
                let (count, a) = read_leb128(&bytes[p..])?;
                p += a;
                for _ in 0..count {
                    let (name_len, a) = read_leb128(&bytes[p..])?;
                    p += a;
                    let name = String::from_utf8_lossy(
                        &bytes[p..p + name_len as usize],
                    )
                    .to_string();
                    p += name_len as usize;
                    let kind_byte = bytes[p];
                    p += 1;
                    // skip index
                    let (_, a) = read_leb128(&bytes[p..])?;
                    p += a;
                    exports.push(WasmExport {
                        name,
                        kind: match kind_byte {
                            0 => "func",
                            1 => "table",
                            2 => "memory",
                            3 => "global",
                            _ => "unknown",
                        },
                    });
                }
            }
            // Custom section
            0 => {
                let mut p = pos;
                let (name_len, a) = read_leb128(&bytes[p..])?;
                p += a;
                if p + (name_len as usize) <= section_end {
                    let name = String::from_utf8_lossy(
                        &bytes[p..p + name_len as usize],
                    )
                    .to_string();
                    custom_sections.push(name);
                }
            }
            _ => {}
        }

        pos = section_end;
    }

    Ok(WasmInfo {
        size: bytes.len() as u64,
        sha256: hash,
        exports,
        custom_sections,
    })
}

/// Decode an unsigned LEB128 integer, returning (value, bytes_consumed).
fn read_leb128(bytes: &[u8]) -> Result<(u64, usize), String> {
    let mut result: u64 = 0;
    let mut shift = 0;
    for (i, &byte) in bytes.iter().enumerate() {
        result |= ((byte & 0x7F) as u64) << shift;
        if byte & 0x80 == 0 {
            return Ok((result, i + 1));
        }
        shift += 7;
        if shift >= 64 {
            return Err("LEB128 overflow".into());
        }
    }
    Err("unexpected end of LEB128".into())
}

fn print_json(contract: &str, path: &str, info: &WasmInfo) {
    let exports: Vec<serde_json::Value> = info
        .exports
        .iter()
        .map(|e| {
            serde_json::json!({
                "name": e.name,
                "kind": e.kind,
            })
        })
        .collect();

    let j = serde_json::json!({
        "contract": contract,
        "path": path,
        "size": info.size,
        "sha256": info.sha256,
        "exports": exports,
        "custom_sections": info.custom_sections,
    });

    println!("{}", serde_json::to_string_pretty(&j).unwrap());
}
