use std::net::TcpListener;
use std::sync::Mutex;
use tauri::{Emitter, Manager, RunEvent};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

struct BackendChild(Mutex<Option<std::process::Child>>);

fn find_free_port() -> u16 {
	let listener = TcpListener::bind("127.0.0.1:0").expect("Failed to find free port");
	listener.local_addr().unwrap().port()
}

#[tauri::command]
fn app_quit(app: tauri::AppHandle) {
	app.exit(0);
}

#[tauri::command]
fn app_restart(app: tauri::AppHandle) {
	#[cfg(any(target_os = "windows", target_os = "linux"))]
	let pid = std::process::id();
	#[cfg(target_os = "windows")]
	{
		let _ = std::process::Command::new("powershell")
			.args([
				"-WindowStyle",
				"Hidden",
				"-Command",
				&format!(
					"Wait-Process -Id {} -ErrorAction SilentlyContinue; shutdown /r /t 0",
					pid
				),
			])
			.spawn();
	}
	#[cfg(target_os = "linux")]
	{
		let _ = std::process::Command::new("sh")
			.args([
				"-c",
				&format!(
					"tail --pid={} -f /dev/null 2>/dev/null; systemctl reboot 2>/dev/null || shutdown -r now 2>/dev/null || sudo shutdown -r now",
					pid
				),
			])
			.spawn();
	}
	#[cfg(target_os = "macos")]
	{
		let _ = std::process::Command::new("osascript")
			.args(["-e", "tell application \"System Events\" to restart"])
			.output();
	}
	app.exit(0);
}

#[tauri::command]
fn app_shutdown(app: tauri::AppHandle) {
	#[cfg(any(target_os = "windows", target_os = "linux"))]
	let pid = std::process::id();
	#[cfg(target_os = "windows")]
	{
		let _ = std::process::Command::new("powershell")
			.args([
				"-WindowStyle",
				"Hidden",
				"-Command",
				&format!(
					"Wait-Process -Id {} -ErrorAction SilentlyContinue; shutdown /s /t 0",
					pid
				),
			])
			.spawn();
	}
	#[cfg(target_os = "linux")]
	{
		let _ = std::process::Command::new("sh")
			.args([
				"-c",
				&format!(
					"tail --pid={} -f /dev/null 2>/dev/null; systemctl poweroff 2>/dev/null || shutdown -h now 2>/dev/null || sudo shutdown -h now",
					pid
				),
			])
			.spawn();
	}
	#[cfg(target_os = "macos")]
	{
		let _ = std::process::Command::new("osascript")
			.args(["-e", "tell application \"System Events\" to shut down"])
			.output();
	}
	app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
	let debug_mode = std::env::args().any(|a| a == "--debug" || a == "/debug");
	let port = find_free_port();

	let app = tauri::Builder::default()
		.plugin(tauri_plugin_window_state::Builder::default().build())
		.invoke_handler(tauri::generate_handler![
			app_quit,
			app_restart,
			app_shutdown
		])
		.setup(move |app| {
			let data_dir = app.path().app_data_dir()?;
			std::fs::create_dir_all(&data_dir)?;
			let data_dir_str = data_dir.to_string_lossy().to_string();
			let port_str = port.to_string();
			let product_name = app.config().product_name.clone().unwrap_or_default();

			// Create main window with backend port in query parameter
			// .devtools(debug_mode) enables F12/inspector in debug mode, disables in normal mode
			// Requires "devtools" feature in Cargo.toml for release builds
			let window =
				tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
					.title(&product_name)
					.initialization_script(&format!("window.__BACKEND_PORT__ = {};", port))
					.devtools(debug_mode)
					.visible(false)
					.build()?;

			// Set initial size to 75% of primary monitor (only on first run)
			let state_file = data_dir.join(".window-state.json");
			if !state_file.exists() {
				if let Ok(Some(monitor)) = window.current_monitor() {
					let size = monitor.size();
					let scale = monitor.scale_factor();
					let width: f64 = (size.width as f64 / scale) * 0.75;
					let height: f64 = (size.height as f64 / scale) * 0.75;
					let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize::new(width, height)));
					let x = (size.width as f64 / scale - width) / 2.0;
					let y = (size.height as f64 / scale - height) / 2.0;
					let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(x, y)));
				}
			}
			let _ = window.show();

			// Create debug console window if in debug mode
			if debug_mode {
				let _debug_window =
					tauri::WebviewWindowBuilder::new(app, "debug", tauri::WebviewUrl::App("debug.html".into()))
						.title(&format!("{} - Backend Debug Console", product_name))
						.inner_size(900.0, 600.0)
						.build()?;
			}

			// Spawn backend
			let exe_dir = std::env::current_exe()
				.expect("Failed to get current exe path")
				.parent()
				.expect("Failed to get exe parent dir")
				.to_path_buf();

			let backend_name = if cfg!(windows) {
				"lish-backend.exe"
			} else {
				"lish-backend"
			};
			let mut backend_path = exe_dir.join(backend_name);
			if !backend_path.exists() {
				// Installed mode (deb/rpm/AppImage/macOS): check resource directory
				if let Ok(res_dir) = app.path().resource_dir() {
					let res_path = res_dir.join(backend_name);
					if res_path.exists() {
						backend_path = res_path;
					}
				}
			}

			let mut cmd = std::process::Command::new(&backend_path);
			// Ensure backend binary is executable (AppImage resources may lose exec permission)
			#[cfg(unix)]
			{
				use std::os::unix::fs::PermissionsExt;
				if let Ok(metadata) = std::fs::metadata(&backend_path) {
					let mut perms = metadata.permissions();
					let mode = perms.mode();
					if mode & 0o111 == 0 {
						perms.set_mode(mode | 0o755);
						let _ = std::fs::set_permissions(&backend_path, perms);
					}
				}
			}
			cmd.args(["--datadir", &data_dir_str, "--port", &port_str]);

			// AppImage sets LD_LIBRARY_PATH to bundled GTK/WebKit libs which conflict
			// with Bun standalone binaries, causing SIGSEGV. Restore original env.
			#[cfg(target_os = "linux")]
			if std::env::var("APPIMAGE").is_ok() {
				// Remove all AppImage-injected environment variables
				for key in &[
					"LD_LIBRARY_PATH",
					"LD_PRELOAD",
					"GDK_PIXBUF_MODULEDIR",
					"GDK_PIXBUF_MODULE_FILE",
					"GSETTINGS_SCHEMA_DIR",
					"GTK_PATH",
					"GTK_EXE_PREFIX",
					"GTK_DATA_PREFIX",
					"GTK_IM_MODULE_FILE",
					"GIO_MODULE_DIR",
					"APPDIR",
					"APPIMAGE",
					"OWD",
					"ARGV0",
				] {
					cmd.env_remove(key);
				}
				// Restore original PATH if AppImage saved it
				if let Ok(orig_path) = std::env::var("APPIMAGE_ORIGINAL_PATH") {
					cmd.env("PATH", orig_path);
				}
			}

			if debug_mode {
				// Pipe stdout/stderr so we can stream them to the debug window
				cmd.stdin(std::process::Stdio::null());
				cmd.stdout(std::process::Stdio::piped());
				cmd.stderr(std::process::Stdio::piped());
			} else {
				cmd.stdin(std::process::Stdio::null());
				cmd.stdout(std::process::Stdio::null());
				cmd.stderr(std::process::Stdio::null());
			}

			#[cfg(target_os = "windows")]
			if !debug_mode {
				use std::os::windows::process::CommandExt;
				cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
			}

			let mut process = cmd.spawn().expect("Failed to spawn backend");

			// Stream backend output to the debug window via Tauri events
			if debug_mode {
				let handle = app.handle().clone();

				if let Some(stdout) = process.stdout.take() {
					let h = handle.clone();
					std::thread::spawn(move || {
						use std::io::BufRead;
						let reader = std::io::BufReader::new(stdout);
						for line in reader.lines().map_while(Result::ok) {
							let _ = h.emit("backend-stdout", &line);
						}
					});
				}

				if let Some(stderr) = process.stderr.take() {
					let h = handle.clone();
					std::thread::spawn(move || {
						use std::io::BufRead;
						let reader = std::io::BufReader::new(stderr);
						for line in reader.lines().map_while(Result::ok) {
							let _ = h.emit("backend-stderr", &line);
						}
					});
				}
			}

			app.manage(BackendChild(Mutex::new(Some(process))));

			Ok(())
		})
		.build(tauri::generate_context!())
		.expect("Error while building application");

	app.run(|handle, event| {
		if let RunEvent::Exit = event {
			let _ = handle.save_window_state(StateFlags::all());
			if let Some(state) = handle.try_state::<BackendChild>() {
				if let Ok(mut guard) = state.0.lock() {
					if let Some(mut child) = guard.take() {
						let _ = child.kill();
						let _ = child.wait();
					}
				}
			}
		}
	});
}
