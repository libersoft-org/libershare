use std::collections::{BTreeMap, VecDeque};
use std::io::{self, BufRead, Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager, WebviewWindow};

const MAX_PAYLOAD: usize = 128 * 1024 * 1024;
const MAX_BODY: usize = MAX_PAYLOAD + 5;
const MAX_QUEUED: usize = 32;
const ACK_TIMEOUT: Duration = Duration::from_secs(15);
const OPEN_TIMEOUT: Duration = Duration::from_secs(10);
const EXIT_TIMEOUT: Duration = Duration::from_secs(35);
const READY: u8 = 1;
const OPEN: u8 = 2;
const OPENED: u8 = 3;
const TEXT: u8 = 4;
const BINARY: u8 = 5;
const CLOSE: u8 = 6;

type Completion = mpsc::Sender<Result<(), &'static str>>;

struct WriteJob {
	body: Vec<u8>,
	done: Option<Completion>,
}

struct Session {
	id: u32,
	open_sent: bool,
	opened: bool,
	next_sequence: u32,
	pending: BTreeMap<u32, (usize, Instant)>,
	pending_bytes: usize,
}

#[derive(Default)]
struct BridgeState {
	ready: bool,
	exited: bool,
	failed: bool,
	shutdown: Option<Instant>,
	exit_code: i32,
	next_session: u32,
	session: Option<Session>,
	queue: VecDeque<WriteJob>,
	queued_bytes: usize,
	queued_frames: usize,
}

impl BridgeState {
	fn check_running(&self) -> Result<(), &'static str> {
		if self.exited || self.failed {
			Err("BACKEND_FAILED")
		} else if self.shutdown.is_some() {
			Err("BACKEND_CLOSING")
		} else if !self.ready {
			Err("BACKEND_STARTING")
		} else {
			Ok(())
		}
	}

	fn queue_control(&mut self, kind: u8, session: u32, done: Option<Completion>) {
		let mut body = vec![kind];
		body.extend_from_slice(&session.to_be_bytes());
		self.queued_bytes += body.len();
		self.queued_frames += 1;
		self.queue.push_back(WriteJob { body, done });
	}

	fn invalidate(&mut self, notify_backend: bool) -> Option<u32> {
		let old = self.session.take()?;
		let mut kept = VecDeque::new();
		while let Some(job) = self.queue.pop_front() {
			if frame_session(&job.body) == old.id {
				self.queued_bytes -= job.body.len();
				self.queued_frames -= 1;
				if let Some(done) = job.done {
					let _ = done.send(Err("IPC_SESSION_CLOSED"));
				}
			} else {
				kept.push_back(job);
			}
		}
		self.queue = kept;
		if notify_backend && old.open_sent && !self.exited && !self.failed {
			self.queue_control(CLOSE, old.id, None);
		}
		Some(old.id)
	}

	fn fail_queued(&mut self) {
		while let Some(job) = self.queue.pop_front() {
			self.queued_bytes -= job.body.len();
			self.queued_frames -= 1;
			if let Some(done) = job.done {
				let _ = done.send(Err("BACKEND_FAILED"));
			}
		}
	}

	fn enqueue_data(&mut self, body: &[u8], done: Completion) -> Result<(), &'static str> {
		self.check_running()?;
		if !(5..=MAX_BODY).contains(&body.len()) || !matches!(body[0], TEXT | BINARY) {
			return Err("IPC_INVALID_FRAME");
		}
		if body[0] == TEXT && std::str::from_utf8(&body[5..]).is_err() {
			return Err("IPC_INVALID_FRAME");
		}
		let id = frame_session(body);
		if !self
			.session
			.as_ref()
			.is_some_and(|s| s.id == id && s.opened)
		{
			return Err("IPC_SESSION_CLOSED");
		}
		if self.queued_frames >= MAX_QUEUED || self.queued_bytes + body.len() > MAX_BODY {
			return Err("IPC_BACKPRESSURE");
		}
		self.queued_bytes += body.len();
		self.queued_frames += 1;
		self.queue.push_back(WriteJob {
			body: body.to_vec(),
			done: Some(done),
		});
		Ok(())
	}

	fn acknowledge(&mut self, id: u32, sequence: u32) {
		if let Some(current) = self.session.as_mut().filter(|s| s.id == id) {
			if let Some((bytes, _)) = current.pending.remove(&sequence) {
				current.pending_bytes -= bytes;
			}
		}
	}
}

struct Inner {
	app: tauri::AppHandle,
	state: Mutex<BridgeState>,
	changed: Condvar,
	child: Mutex<Child>,
}

#[derive(Clone)]
pub struct BackendBridge(Arc<Inner>);

fn frame_session(body: &[u8]) -> u32 {
	u32::from_be_bytes(body[1..5].try_into().expect("validated frame header"))
}

fn read_frame(reader: &mut impl Read) -> io::Result<Option<Vec<u8>>> {
	let mut prefix = [0u8; 4];
	loop {
		match reader.read(&mut prefix[..1]) {
			Ok(0) => return Ok(None),
			Ok(_) => break,
			Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
			Err(error) => return Err(error),
		}
	}
	reader.read_exact(&mut prefix[1..])?;
	let length = u32::from_be_bytes(prefix) as usize;
	if !(5..=MAX_BODY).contains(&length) {
		return Err(io::Error::new(
			io::ErrorKind::InvalidData,
			"invalid IPC frame length",
		));
	}
	let mut body = vec![0; length];
	reader.read_exact(&mut body)?;
	Ok(Some(body))
}

pub fn is_app_url(url: &tauri::Url) -> bool {
	let local = (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
		|| (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost"));
	local
		&& matches!(url.path(), "" | "/" | "/index.html")
		&& url.username().is_empty()
		&& url.password().is_none()
		&& url.port().is_none()
}

pub fn require_main(window: &WebviewWindow) -> Result<(), String> {
	if window.label() != "main" || !window.url().map(|url| is_app_url(&url)).unwrap_or(false) {
		return Err("IPC_NOT_ALLOWED".into());
	}
	Ok(())
}

impl BackendBridge {
	pub fn spawn(app: tauri::AppHandle, command: &mut Command, debug: bool) -> io::Result<Self> {
		command
			.stdin(Stdio::piped())
			.stdout(Stdio::piped())
			.stderr(Stdio::piped());
		let mut child = command.spawn()?;
		let stdin = child.stdin.take().expect("piped stdin");
		let stdout = child.stdout.take().expect("piped stdout");
		let stderr = child.stderr.take().expect("piped stderr");
		let bridge = Self(Arc::new(Inner {
			app,
			state: Mutex::new(BridgeState::default()),
			changed: Condvar::new(),
			child: Mutex::new(child),
		}));
		let writer = bridge.clone();
		std::thread::spawn(move || writer.write_loop(stdin));
		let reader = bridge.clone();
		std::thread::spawn(move || reader.read_loop(stdout));
		let supervisor = bridge.clone();
		std::thread::spawn(move || supervisor.supervise());
		let logs = bridge.clone();
		std::thread::spawn(move || {
			let mut reader = io::BufReader::new(stderr);
			let mut line = Vec::new();
			loop {
				let Ok(buffer) = reader.fill_buf() else { break };
				if buffer.is_empty() {
					break;
				}
				let length = buffer
					.iter()
					.position(|byte| *byte == b'\n')
					.map_or(buffer.len(), |i| i + 1);
				let end = buffer[length - 1] == b'\n';
				let keep = length.min(16 * 1024 - line.len());
				line.extend_from_slice(&buffer[..keep]);
				reader.consume(length);
				if end {
					if debug {
						let _ = logs.0.app.emit_to(
							"debug",
							"backend-stderr",
							String::from_utf8_lossy(&line).trim_end(),
						);
					}
					line.clear();
				}
			}
		});
		Ok(bridge)
	}

	fn callback(&self, session: u32, sequence: u32, data: Option<&str>) -> Result<(), ()> {
		let window = self.0.app.get_webview_window("main").ok_or(())?;
		require_main(&window).map_err(|_| ())?;
		let envelope = match data {
			Some(data) => {
				serde_json::json!({ "session": session, "sequence": sequence, "type": "message", "data": data })
			}
			None => serde_json::json!({ "session": session, "sequence": sequence, "type": "closed" }),
		};
		let argument = serde_json::to_string(&envelope).map_err(|_| ())?;
		// Native eval targets this WebView directly; Tauri event targets and channel caches
		// are not an isolation boundary between the main and debug WebViews.
		window
			.eval(format!("window.__LIBERSHARE_IPC_RECEIVE__?.({argument});"))
			.map_err(|_| ())
	}

	pub fn invalidate(&self) {
		let old = self.0.state.lock().unwrap().invalidate(true);
		self.0.changed.notify_all();
		if let Some(old) = old {
			let _ = self.callback(old, 0, None);
		}
	}

	fn close_session(&self, id: u32) {
		let old = {
			let mut state = self.0.state.lock().unwrap();
			if state.session.as_ref().is_some_and(|s| s.id == id) {
				state.invalidate(true)
			} else {
				None
			}
		};
		self.0.changed.notify_all();
		if let Some(old) = old {
			let _ = self.callback(old, 0, None);
		}
	}

	fn fatal(&self) {
		let old = {
			let mut state = self.0.state.lock().unwrap();
			state.failed = true;
			state.ready = false;
			let old = state.invalidate(false);
			state.fail_queued();
			old
		};
		self.0.changed.notify_all();
		if let Some(old) = old {
			let _ = self.callback(old, 0, None);
		}
		let _ = self.0.child.lock().unwrap().kill();
	}

	fn write_loop(&self, mut stdin: std::process::ChildStdin) {
		loop {
			let job = {
				let mut state = self.0.state.lock().unwrap();
				while state.queue.is_empty() && state.shutdown.is_none() && !state.exited && !state.failed {
					state = self.0.changed.wait(state).unwrap();
				}
				if state.exited || state.failed || state.queue.is_empty() {
					return;
				}
				let job = state.queue.pop_front().unwrap();
				if job.body[0] == OPEN {
					if let Some(session) = state
						.session
						.as_mut()
						.filter(|s| s.id == frame_session(&job.body))
					{
						session.open_sent = true;
					}
				}
				job
			};
			let result = stdin
				.write_all(&(job.body.len() as u32).to_be_bytes())
				.and_then(|_| stdin.write_all(&job.body));
			{
				let mut state = self.0.state.lock().unwrap();
				state.queued_bytes -= job.body.len();
				state.queued_frames -= 1;
			}
			if let Some(done) = job.done {
				let _ = done.send(result.as_ref().map(|_| ()).map_err(|_| "BACKEND_FAILED"));
			}
			self.0.changed.notify_all();
			if result.is_err() {
				self.fatal();
				return;
			}
		}
	}

	fn read_loop(&self, mut stdout: std::process::ChildStdout) {
		loop {
			let body = match read_frame(&mut stdout) {
				Ok(Some(body)) => body,
				Ok(None) => {
					if self.0.state.lock().unwrap().shutdown.is_none() {
						self.fatal();
					}
					return;
				}
				Err(_) => {
					self.fatal();
					return;
				}
			};
			let session = frame_session(&body);
			match body[0] {
				READY if session == 0 && body[5..] == [1] => {
					let mut state = self.0.state.lock().unwrap();
					if state.ready {
						drop(state);
						self.fatal();
						return;
					}
					if state.shutdown.is_none() && !state.failed && !state.exited {
						state.ready = true;
					}
					self.0.changed.notify_all();
				}
				OPENED if session != 0 && body.len() == 5 => {
					let mut state = self.0.state.lock().unwrap();
					if let Some(current) = state
						.session
						.as_mut()
						.filter(|s| s.id == session && s.open_sent)
					{
						current.opened = true;
					}
					self.0.changed.notify_all();
				}
				TEXT if session != 0 => {
					let Ok(text) = std::str::from_utf8(&body[5..]) else {
						self.fatal();
						return;
					};
					self.deliver(session, text);
				}
				CLOSE if session != 0 && body.len() == 5 => {
					let old = {
						let mut state = self.0.state.lock().unwrap();
						if state.session.as_ref().is_some_and(|s| s.id == session) {
							state.invalidate(false)
						} else {
							None
						}
					};
					self.0.changed.notify_all();
					if let Some(old) = old {
						let _ = self.callback(old, 0, None);
					}
				}
				_ => {
					self.fatal();
					return;
				}
			}
		}
	}

	fn deliver(&self, id: u32, text: &str) {
		let sequence = {
			let mut state = self.0.state.lock().unwrap();
			loop {
				if state.shutdown.is_some() || state.exited || state.failed {
					return;
				}
				let Some(session) = state.session.as_mut().filter(|s| s.id == id && s.opened) else {
					return;
				};
				if session.pending.len() < MAX_QUEUED && session.pending_bytes + text.len() <= MAX_PAYLOAD {
					let Some(sequence) = session.next_sequence.checked_add(1) else {
						drop(state);
						self.close_session(id);
						return;
					};
					session.next_sequence = sequence;
					session
						.pending
						.insert(sequence, (text.len(), Instant::now()));
					session.pending_bytes += text.len();
					break sequence;
				}
				state = self.0.changed.wait(state).unwrap();
			}
		};
		if self.callback(id, sequence, Some(text)).is_err() {
			self.close_session(id);
		}
	}

	fn supervise(&self) {
		loop {
			let mut outcome = self.0.child.lock().unwrap().try_wait();
			let (force, stale) = {
				let state = self.0.state.lock().unwrap();
				let force = state
					.shutdown
					.is_some_and(|started| started.elapsed() >= EXIT_TIMEOUT);
				let stale = state
					.session
					.as_ref()
					.filter(|s| {
						s.pending
							.values()
							.any(|(_, at)| at.elapsed() >= ACK_TIMEOUT)
					})
					.map(|s| s.id);
				(force, stale)
			};
			if let Some(id) = stale {
				let old = {
					let mut state = self.0.state.lock().unwrap();
					if state.session.as_ref().is_some_and(|s| s.id == id) {
						state.invalidate(true)
					} else {
						None
					}
				};
				self.0.changed.notify_all();
				if let Some(old) = old {
					let _ = self.callback(old, 0, None);
				}
			}
			if force && matches!(outcome, Ok(None)) {
				let mut child = self.0.child.lock().unwrap();
				let _ = child.kill();
				outcome = child.wait().map(Some);
			}
			match outcome {
				Ok(None) => std::thread::sleep(Duration::from_millis(25)),
				result => {
					let (old, shutdown, code) = {
						let mut state = self.0.state.lock().unwrap();
						state.exited = true;
						state.ready = false;
						state.exit_code = if force || state.failed {
							1
						} else {
							result.ok().flatten().and_then(|s| s.code()).unwrap_or(1)
						};
						let old = state.invalidate(false);
						state.fail_queued();
						(old, state.shutdown.is_some(), state.exit_code)
					};
					self.0.changed.notify_all();
					if let Some(old) = old {
						let _ = self.callback(old, 0, None);
					}
					if shutdown {
						self.0.app.exit(code);
					}
					return;
				}
			}
		}
	}

	pub fn shutdown_exit_code(&self) -> Option<i32> {
		let state = self.0.state.lock().unwrap();
		(state.shutdown.is_some() && state.exited).then_some(state.exit_code)
	}

	pub fn shutdown(&self) {
		let (old, done) = {
			let mut state = self.0.state.lock().unwrap();
			if state.shutdown.is_some() {
				return;
			}
			state.shutdown = Some(Instant::now());
			state.ready = false;
			// Already accepted writes drain before the writer drops stdin and sends EOF.
			let old = state.session.take().map(|s| s.id);
			(old, state.exited.then_some(state.exit_code))
		};
		self.0.changed.notify_all();
		if let Some(old) = old {
			let _ = self.callback(old, 0, None);
		}
		if let Some(code) = done {
			self.0.app.exit(code);
		}
	}

	fn open(&self) -> Result<(u32, mpsc::Receiver<Result<(), &'static str>>), &'static str> {
		let (done, completion) = mpsc::channel();
		let (id, old) = {
			let mut state = self.0.state.lock().unwrap();
			state.check_running()?;
			let id = state
				.next_session
				.checked_add(1)
				.ok_or("IPC_SESSION_EXHAUSTED")?;
			let old = state.invalidate(true);
			state.next_session = id;
			state.session = Some(Session {
				id,
				open_sent: false,
				opened: false,
				next_sequence: 0,
				pending: BTreeMap::new(),
				pending_bytes: 0,
			});
			state.queue_control(OPEN, id, Some(done));
			(id, old)
		};
		self.0.changed.notify_all();
		if let Some(old) = old {
			let _ = self.callback(old, 0, None);
		}
		Ok((id, completion))
	}

	fn wait_opened(&self, id: u32, deadline: Instant) -> Result<(), &'static str> {
		let mut state = self.0.state.lock().unwrap();
		loop {
			state.check_running()?;
			let session = state
				.session
				.as_ref()
				.filter(|s| s.id == id)
				.ok_or("IPC_SESSION_CLOSED")?;
			if session.opened {
				return Ok(());
			}
			let Some(wait) = deadline.checked_duration_since(Instant::now()) else {
				return Err("IPC_OPEN_TIMEOUT");
			};
			state = self.0.changed.wait_timeout(state, wait).unwrap().0;
		}
	}
}

#[tauri::command]
pub async fn backend_open(
	window: WebviewWindow,
	bridge: tauri::State<'_, BackendBridge>,
) -> Result<u32, String> {
	require_main(&window)?;
	let bridge = bridge.inner().clone();
	let deadline = Instant::now() + OPEN_TIMEOUT;
	let (id, completion) = bridge.open().map_err(str::to_owned)?;
	tauri::async_runtime::spawn_blocking(move || {
		let result = completion
			.recv_timeout(deadline.saturating_duration_since(Instant::now()))
			.map_err(|_| "IPC_OPEN_TIMEOUT")
			.and_then(|r| r)
			.and_then(|_| bridge.wait_opened(id, deadline))
			.map(|_| id);
		if result.is_err() {
			bridge.close_session(id);
		}
		result
	})
	.await
	.map_err(|_| "BACKEND_FAILED".to_string())?
	.map_err(str::to_owned)
}

#[tauri::command]
pub async fn backend_send(
	window: WebviewWindow,
	bridge: tauri::State<'_, BackendBridge>,
	request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
	require_main(&window)?;
	let tauri::ipc::InvokeBody::Raw(body) = request.body() else {
		return Err("IPC_INVALID_FRAME".into());
	};
	if !(5..=MAX_BODY).contains(&body.len()) || !matches!(body[0], TEXT | BINARY) {
		return Err("IPC_INVALID_FRAME".into());
	}
	let id = frame_session(body);
	let (done, completion) = mpsc::channel();
	{
		let mut state = bridge.0.state.lock().unwrap();
		state.enqueue_data(body, done).map_err(str::to_owned)?;
	}
	bridge.0.changed.notify_all();
	let bridge = bridge.inner().clone();
	tauri::async_runtime::spawn_blocking(move || {
		let result = completion
			.recv_timeout(ACK_TIMEOUT)
			.unwrap_or(Err("IPC_WRITE_TIMEOUT"));
		if result.is_err() {
			bridge.close_session(id);
		}
		result
	})
	.await
	.map_err(|_| "BACKEND_FAILED".to_string())?
	.map_err(str::to_owned)
}

#[tauri::command]
pub fn backend_close(
	window: WebviewWindow,
	bridge: tauri::State<'_, BackendBridge>,
	session: u32,
) -> Result<(), String> {
	require_main(&window)?;
	bridge.close_session(session);
	Ok(())
}

#[tauri::command]
pub fn backend_ack(
	window: WebviewWindow,
	bridge: tauri::State<'_, BackendBridge>,
	session: u32,
	sequence: u32,
) -> Result<(), String> {
	require_main(&window)?;
	let mut state = bridge.0.state.lock().unwrap();
	state.acknowledge(session, sequence);
	bridge.0.changed.notify_all();
	Ok(())
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn frames_reject_short_large_and_truncated_bodies() {
		for length in [0, 4, MAX_BODY + 1] {
			assert!(read_frame(&mut io::Cursor::new((length as u32).to_be_bytes())).is_err());
		}
		assert!(read_frame(&mut io::Cursor::new([0, 0])).is_err());
		assert!(read_frame(&mut io::Cursor::new([0, 0, 0, 5, TEXT])).is_err());
		assert!(read_frame(&mut io::Cursor::new([])).unwrap().is_none());
	}

	#[test]
	fn frames_keep_binary_bytes_and_session() {
		let bytes = [0, 0, 0, 8, BINARY, 0, 0, 1, 2, 0, 255, 10];
		let frame = read_frame(&mut io::Cursor::new(bytes)).unwrap().unwrap();
		assert_eq!(frame_session(&frame), 258);
		assert_eq!(&frame[5..], &[0, 255, 10]);
	}

	#[test]
	fn only_the_main_application_document_is_local() {
		for url in [
			"tauri://localhost",
			"tauri://localhost/index.html",
			"http://tauri.localhost/",
			"https://tauri.localhost/index.html",
		] {
			assert!(is_app_url(&url.parse().unwrap()));
		}
		for url in [
			"tauri://localhost/debug.html",
			"http://tauri.localhost/debug.html",
			"https://example.com/",
			"http://localhost/",
			"http://tauri.localhost:80/evil",
			"tauri://evil/index.html",
		] {
			assert!(!is_app_url(&url.parse().unwrap()));
		}
	}

	#[test]
	fn invalidation_rejects_queued_work_and_keeps_close_after_an_open_was_sent() {
		let mut state = BridgeState::default();
		state.session = Some(Session {
			id: 1,
			open_sent: true,
			opened: true,
			next_sequence: 0,
			pending: BTreeMap::new(),
			pending_bytes: 0,
		});
		let (done, completion) = mpsc::channel();
		state.queue_control(TEXT, 1, Some(done));
		assert_eq!(state.invalidate(true), Some(1));
		assert_eq!(completion.recv().unwrap(), Err("IPC_SESSION_CLOSED"));
		assert_eq!(state.queue.len(), 1);
		assert_eq!(state.queue.front().unwrap().body, [CLOSE, 0, 0, 0, 1]);
		assert_eq!(state.queued_bytes, 5);
		assert_eq!(state.queued_frames, 1);
	}

	fn active_state() -> BridgeState {
		BridgeState {
			ready: true,
			next_session: 2,
			session: Some(Session {
				id: 2,
				open_sent: true,
				opened: true,
				next_sequence: 0,
				pending: BTreeMap::new(),
				pending_bytes: 0,
			}),
			..BridgeState::default()
		}
	}

	#[test]
	fn input_requires_a_live_session_and_rejects_control_and_invalid_text_frames() {
		let mut state = active_state();
		for body in [
			vec![OPEN, 0, 0, 0, 2],
			vec![TEXT, 0, 0, 0, 1],
			vec![TEXT, 0, 0, 0, 2, 255],
			vec![TEXT],
		] {
			let (done, _) = mpsc::channel();
			assert!(state.enqueue_data(&body, done).is_err());
		}
		assert_eq!(state.queued_bytes, 0);
		assert!(state.queue.is_empty());
		let (done, _) = mpsc::channel();
		assert!(state.enqueue_data(&[BINARY, 0, 0, 0, 2, 255], done).is_ok());
	}

	#[test]
	fn input_queue_is_limited_by_count_and_bytes() {
		let mut state = active_state();
		for _ in 0..MAX_QUEUED {
			let (done, _) = mpsc::channel();
			state.enqueue_data(&[TEXT, 0, 0, 0, 2], done).unwrap();
		}
		let (done, _) = mpsc::channel();
		assert_eq!(
			state.enqueue_data(&[TEXT, 0, 0, 0, 2], done),
			Err("IPC_BACKPRESSURE")
		);
		let mut state = active_state();
		// The budget includes a frame already removed from the queue by the writer.
		state.queued_bytes = MAX_BODY - 4;
		let (done, _) = mpsc::channel();
		assert_eq!(
			state.enqueue_data(&[TEXT, 0, 0, 0, 2], done),
			Err("IPC_BACKPRESSURE")
		);
	}

	#[test]
	fn stale_or_duplicate_ack_cannot_release_another_sessions_credit() {
		let mut state = active_state();
		let session = state.session.as_mut().unwrap();
		session.pending.insert(1, (42, Instant::now()));
		session.pending_bytes = 42;
		state.acknowledge(1, 1);
		assert_eq!(state.session.as_ref().unwrap().pending_bytes, 42);
		state.acknowledge(2, 2);
		assert_eq!(state.session.as_ref().unwrap().pending_bytes, 42);
		state.acknowledge(2, 1);
		state.acknowledge(2, 1);
		assert_eq!(state.session.as_ref().unwrap().pending_bytes, 0);
	}

	#[test]
	fn reload_keeps_the_session_counter_and_drops_unsent_open_without_a_close() {
		let mut state = active_state();
		state.session.as_mut().unwrap().open_sent = false;
		state.queue_control(OPEN, 2, None);
		assert_eq!(state.invalidate(true), Some(2));
		assert_eq!(state.next_session, 2);
		assert_eq!(state.queued_bytes, 0);
		assert!(state.queue.is_empty());
	}
}
