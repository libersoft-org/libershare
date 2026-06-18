fn main() {
	// Regenerate the Tauri config files from shared/src/product.json before
	// tauri_build reads them, so branding stays in sync without a manual step
	// (rust-analyzer, plain `cargo build`, etc.). The generated *.json files are
	// gitignored; the committed *.template files are the source. Failures are
	// non-fatal: build.sh / build.bat also run this generator, and tauri_build
	// surfaces a clear error if a required config is genuinely missing.
	let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
	println!("cargo:rerun-if-changed=sync-config.ts");
	println!("cargo:rerun-if-changed=tauri.conf.json.template");
	println!("cargo:rerun-if-changed=tauri.linux.conf.json.template");
	println!("cargo:rerun-if-changed=../shared/src/product.json");
	match std::process::Command::new("bun").arg("sync-config.ts").current_dir(&manifest_dir).status() {
		Ok(status) if status.success() => {}
		Ok(status) => println!("cargo:warning=sync-config.ts exited with {status}; using existing Tauri config files"),
		Err(err) => println!("cargo:warning=could not run `bun sync-config.ts` ({err}); using existing Tauri config files"),
	}

	// Pass target triple to the code at compile time
	let target = std::env::var("TARGET").unwrap();
	println!("cargo:rustc-env=TARGET_TRIPLE={}", target);
	tauri_build::build()
}
