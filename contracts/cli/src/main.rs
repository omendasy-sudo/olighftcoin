use clap::{Parser, Subcommand};

mod build;
mod test;
mod inspect;
mod version;
mod deploy;
mod sandbox;
mod config;
mod util;

/// OLIGHFT Smart Contract Developer CLI
///
/// Compile, test, inspect, version, and deploy Soroban contracts.
/// Includes a complete local testing mode identical to on-chain behaviour.
#[derive(Parser)]
#[command(
    name = "olighft",
    version,
    about = "OLIGHFT Smart Contract CLI — build · test · inspect · version · deploy",
    long_about = None
)]
struct Cli {
    #[command(subcommand)]
    command: Commands,

    /// Path to the workspace root (defaults to current directory)
    #[arg(long, global = true, default_value = ".")]
    workspace: String,

    /// Enable verbose output
    #[arg(short, long, global = true)]
    verbose: bool,
}

#[derive(Subcommand)]
enum Commands {
    /// Compile one or all contracts to optimised WASM
    Build(build::BuildArgs),

    /// Run contract test suites
    Test(test::TestArgs),

    /// Inspect a compiled WASM: size, hash, exported functions, storage keys
    Inspect(inspect::InspectArgs),

    /// Manage contract semantic versions and changelogs
    Version(version::VersionArgs),

    /// Deploy contracts to a Soroban network (local / testnet / mainnet)
    Deploy(deploy::DeployArgs),

    /// Launch an interactive local sandbox that mirrors on-chain execution
    Sandbox(sandbox::SandboxArgs),

    /// Print resolved workspace configuration
    Config,
}

fn main() {
    let cli = Cli::parse();

    let result = match cli.command {
        Commands::Build(args) => build::run(args, &cli.workspace, cli.verbose),
        Commands::Test(args) => test::run(args, &cli.workspace, cli.verbose),
        Commands::Inspect(args) => inspect::run(args, &cli.workspace, cli.verbose),
        Commands::Version(args) => version::run(args, &cli.workspace, cli.verbose),
        Commands::Deploy(args) => deploy::run(args, &cli.workspace, cli.verbose),
        Commands::Sandbox(args) => sandbox::run(args, &cli.workspace, cli.verbose),
        Commands::Config => config::run(&cli.workspace, cli.verbose),
    };

    if let Err(e) = result {
        eprintln!("{} {}", colored::Colorize::red("error:"), e);
        std::process::exit(1);
    }
}
