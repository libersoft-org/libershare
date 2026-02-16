use std::io::Write;
use std::net::TcpListener;
use std::sync::Mutex;
use tauri::{Manager, RunEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

struct BackendChild(Mutex<Option<CommandChild>>);

fn find_free_port() -> u16 {
	let listener = TcpListener::bind("127.0.0.1:0").expect("Failed to find free port");
	listener.local_addr().unwrap().port()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
	let debug_mode = std::env::args().any(|a| a == "--debug");
	let port = find_free_port();

	let app = tauri::Builder::default()
		.plugin(tauri_plugin_shell::init())
		.plugin(tauri_plugin_window_state::Builder::default().build())
		.setup(move |app| {
			let data_dir = app.path().app_data_dir()?;
			std::fs::create_dir_all(&data_dir)?;
			let data_dir_str = data_dir.to_string_lossy().to_string();
			let port_str = port.to_string();

			// Create main window with backend port in query parameter
			let window =
				tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
					.title("LiberShare")
					.initialization_script(&format!("window.__BACKEND_PORT__ = {};", port))
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
					let _ = window.center();
				}
			}
			let _ = window.show();

			// Spawn backend sidecar
			let sidecar = app
				.shell()
				.sidecar("lish-backend")
				.expect("Failed to create sidecar command")
				.args(["--datadir", &data_dir_str, "--port", &port_str]);

			let (mut rx, child) = sidecar.spawn().expect("Failed to spawn backend sidecar");
			app.manage(BackendChild(Mutex::new(Some(child))));

			// Forward sidecar output to terminal in debug mode
			tauri::async_runtime::spawn(async move {
				while let Some(event) = rx.recv().await {
					if debug_mode {
						match event {
							CommandEvent::Stdout(bytes) => {
								let _ = std::io::stdout().write_all(&bytes);
								let _ = std::io::stdout().write_all(b"\n");
								let _ = std::io::stdout().flush();
							}
							CommandEvent::Stderr(bytes) => {
								let _ = std::io::stderr().write_all(&bytes);
								let _ = std::io::stderr().write_all(b"\n");
								let _ = std::io::stderr().flush();
							}
							CommandEvent::Terminated(status) => {
								eprintln!("[LiberShare] Backend terminated: {:?}", status);
							}
							_ => {}
						}
					}
				}
			});

			Ok(())
		})
		.build(tauri::generate_context!())
		.expect("Error while building LiberShare");

	app.run(|handle, event| {
		if let RunEvent::Exit = event {
			let _ = handle.save_window_state(StateFlags::all());
			if let Some(state) = handle.try_state::<BackendChild>() {
				if let Ok(mut guard) = state.0.lock() {
					if let Some(child) = guard.take() {
						let _ = child.kill();
					}
				}
			}
		}
	});
}
