#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

#[cfg(target_os = "windows")]
extern "system" {
	fn AllocConsole() -> i32;
	fn SetStdHandle(nStdHandle: u32, hHandle: *mut std::ffi::c_void) -> i32;
	fn CreateFileW(
		lpFileName: *const u16,
		dwDesiredAccess: u32,
		dwShareMode: u32,
		lpSecurityAttributes: *mut std::ffi::c_void,
		dwCreationDisposition: u32,
		dwFlagsAndAttributes: u32,
		hTemplateFile: *mut std::ffi::c_void,
	) -> *mut std::ffi::c_void;
}

#[cfg(target_os = "windows")]
fn setup_console() {
	unsafe {
		AllocConsole();
		// Open CONOUT$ handle to the new console and set it as stdout/stderr
		let conout: Vec<u16> = "CONOUT$\0".encode_utf16().collect();
		let handle = CreateFileW(
			conout.as_ptr(),
			0x40000000, // GENERIC_WRITE
			0x00000003, // FILE_SHARE_READ | FILE_SHARE_WRITE
			std::ptr::null_mut(),
			3, // OPEN_EXISTING
			0,
			std::ptr::null_mut(),
		);
		if !handle.is_null() {
			SetStdHandle(0xFFFFFFF5u32, handle); // STD_OUTPUT_HANDLE
			SetStdHandle(0xFFFFFFF4u32, handle); // STD_ERROR_HANDLE
		}
	}
}

fn main() {
	#[cfg(target_os = "windows")]
	if std::env::args().any(|a| a == "--debug" || a == "/debug") {
		setup_console();
	}

	app_lib::run();
}
