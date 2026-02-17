fn main() {
	// Pass target triple to the code at compile time
	let target = std::env::var("TARGET").unwrap();
	println!("cargo:rustc-env=TARGET_TRIPLE={}", target);
	tauri_build::build()
}
