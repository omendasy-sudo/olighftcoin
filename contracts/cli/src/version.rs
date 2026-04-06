use clap::{Args, Subcommand};
use colored::Colorize;
use std::fs;

use crate::util;

#[derive(Args)]
pub struct VersionArgs {
    #[command(subcommand)]
    pub action: VersionAction,
}

#[derive(Subcommand)]
pub enum VersionAction {
    /// Show current versions of all contracts
    Show,

    /// Bump a contract's version (patch, minor, or major)
    Bump {
        /// Contract to version
        #[arg(short, long)]
        contract: String,

        /// Bump level: patch | minor | major
        #[arg(short, long, default_value = "patch")]
        level: String,

        /// Optional changelog entry
        #[arg(short, long)]
        message: Option<String>,
    },

    /// Set an explicit version on a contract
    Set {
        /// Contract name
        #[arg(short, long)]
        contract: String,

        /// Exact semver string (e.g. "2.1.0")
        #[arg(short, long)]
        version: String,
    },

    /// Show version changelog
    Log {
        /// Contract (omit for all)
        #[arg(short, long)]
        contract: Option<String>,
    },
}

pub fn run(args: VersionArgs, workspace: &str, _verbose: bool) -> Result<(), String> {
    let root = util::resolve_workspace(workspace);

    match args.action {
        VersionAction::Show => show_all(&root),
        VersionAction::Bump {
            contract,
            level,
            message,
        } => bump(&root, &contract, &level, message.as_deref()),
        VersionAction::Set { contract, version } => set_version(&root, &contract, &version),
        VersionAction::Log { contract } => show_log(&root, contract.as_deref()),
    }
}

fn cargo_toml_path(root: &std::path::Path, contract: &str) -> std::path::PathBuf {
    root.join(contract).join("Cargo.toml")
}

fn read_version(root: &std::path::Path, contract: &str) -> Result<semver::Version, String> {
    let path = cargo_toml_path(root, contract);
    let contents =
        fs::read_to_string(&path).map_err(|e| format!("cannot read {}: {}", path.display(), e))?;
    let doc: toml::Value = contents
        .parse()
        .map_err(|e| format!("invalid toml in {}: {}", contract, e))?;
    let ver_str = doc
        .get("package")
        .and_then(|p| p.get("version"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("no package.version in {}", contract))?;
    semver::Version::parse(ver_str).map_err(|e| format!("invalid semver `{}`: {}", ver_str, e))
}

fn write_version(
    root: &std::path::Path,
    contract: &str,
    new_ver: &semver::Version,
) -> Result<(), String> {
    let path = cargo_toml_path(root, contract);
    let contents =
        fs::read_to_string(&path).map_err(|e| format!("cannot read {}: {}", path.display(), e))?;

    // Simple string replacement of `version = "x.y.z"`
    let old_ver = read_version(root, contract)?;
    let updated = contents.replace(
        &format!("version = \"{}\"", old_ver),
        &format!("version = \"{}\"", new_ver),
    );

    fs::write(&path, updated).map_err(|e| format!("cannot write {}: {}", path.display(), e))?;
    Ok(())
}

fn show_all(root: &std::path::Path) -> Result<(), String> {
    util::header("Contract Versions");
    for name in util::CONTRACT_CRATES {
        match read_version(root, name) {
            Ok(v) => println!("  {:16} {}", name, v.to_string().green()),
            Err(e) => println!("  {:16} {}", name, e.red()),
        }
    }
    println!();
    Ok(())
}

fn bump(
    root: &std::path::Path,
    contract: &str,
    level: &str,
    message: Option<&str>,
) -> Result<(), String> {
    if !util::CONTRACT_CRATES.contains(&contract) {
        return Err(format!("unknown contract `{}`", contract));
    }

    let mut ver = read_version(root, contract)?;
    let old = ver.clone();

    match level {
        "patch" => ver.patch += 1,
        "minor" => {
            ver.minor += 1;
            ver.patch = 0;
        }
        "major" => {
            ver.major += 1;
            ver.minor = 0;
            ver.patch = 0;
        }
        _ => return Err(format!("invalid bump level `{}` (patch|minor|major)", level)),
    }

    write_version(root, contract, &ver)?;

    // Append to changelog
    if let Some(msg) = message {
        append_changelog(root, contract, &ver, msg)?;
    }

    util::ok(&format!(
        "{}: {} → {}",
        contract,
        old.to_string().dimmed(),
        ver.to_string().green()
    ));
    Ok(())
}

fn set_version(
    root: &std::path::Path,
    contract: &str,
    version: &str,
) -> Result<(), String> {
    if !util::CONTRACT_CRATES.contains(&contract) {
        return Err(format!("unknown contract `{}`", contract));
    }
    let new_ver =
        semver::Version::parse(version).map_err(|e| format!("invalid semver `{}`: {}", version, e))?;
    let old = read_version(root, contract)?;
    write_version(root, contract, &new_ver)?;
    util::ok(&format!(
        "{}: {} → {}",
        contract,
        old.to_string().dimmed(),
        new_ver.to_string().green()
    ));
    Ok(())
}

fn changelog_path(root: &std::path::Path, contract: &str) -> std::path::PathBuf {
    root.join(contract).join("CHANGELOG")
}

fn append_changelog(
    root: &std::path::Path,
    contract: &str,
    ver: &semver::Version,
    message: &str,
) -> Result<(), String> {
    let path = changelog_path(root, contract);
    let existing = fs::read_to_string(&path).unwrap_or_default();
    let timestamp = chrono::Utc::now().format("%Y-%m-%d");
    let entry = format!("## {} — {}\n- {}\n\n", ver, timestamp, message);
    let new_content = format!("{}{}", entry, existing);
    fs::write(&path, new_content)
        .map_err(|e| format!("cannot write changelog: {}", e))?;
    Ok(())
}

fn show_log(root: &std::path::Path, contract: Option<&str>) -> Result<(), String> {
    let crates: Vec<&str> = match contract {
        Some(c) => {
            if !util::CONTRACT_CRATES.contains(&c) {
                return Err(format!("unknown contract `{}`", c));
            }
            vec![c]
        }
        None => util::CONTRACT_CRATES.to_vec(),
    };

    for name in crates {
        let path = changelog_path(root, name);
        util::header(&format!("{} changelog", name));
        if path.exists() {
            let content = fs::read_to_string(&path)
                .map_err(|e| format!("cannot read changelog: {}", e))?;
            println!("{}", content);
        } else {
            println!("  {}", "(no changelog)".dimmed());
        }
    }
    Ok(())
}
