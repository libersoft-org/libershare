#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

#[cfg(target_os = "windows")]
extern "system" {
	fn AllocConsole() -> i32;
}

fn main() {
	// On Windows, allocate a new console window for --debug / /debug output
	#[cfg(target_os = "windows")]
	if std::env::args().any(|a| a == "--debug" || a == "/debug") {
		unsafe {
			AllocConsole();
		}
	}

	app_lib::run();
}
