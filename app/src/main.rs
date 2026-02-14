#![cfg_attr(
	all(not(debug_assertions), target_os = "windows"),
	windows_subsystem = "windows"
)]

#[cfg(target_os = "windows")]
extern "system" {
	fn AttachConsole(dw_process_id: u32) -> i32;
}

fn main() {
	// On Windows release builds, attach to parent console for --debug output
	#[cfg(target_os = "windows")]
	if std::env::args().any(|a| a == "--debug") {
		unsafe {
			AttachConsole(0xFFFFFFFF); // ATTACH_PARENT_PROCESS
		}
	}

	libershare_app_lib::run();
}
