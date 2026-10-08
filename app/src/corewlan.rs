//! macOS Wi-Fi done in the app process on behalf of the backend.
//!
//! macOS reveals Wi-Fi network names only to the application the person granted Location
//! Services, and the backend is a separate program to the system, so it sends its CoreWLAN
//! requests here over the desktop pipe. Only raw CoreWLAN data goes back: the backend shapes
//! it with the same rules its own worker applies. A join still has to pick the access point
//! from this process's own scan, so that choice and the check after it live here too.

use objc2::msg_send;
use objc2::rc::{autoreleasepool, Retained};
use objc2::runtime::{AnyClass, AnyObject, Bool};
use serde_json::{json, Value};
use std::ffi::{c_char, c_void, CStr, CString};
use std::time::Duration;

#[link(name = "CoreWLAN", kind = "framework")]
extern "C" {}

type Object = Retained<AnyObject>;

/// Every CWSecurity value the scanner tests, from CoreWLANTypes.h.
const SECURITY_PROBES: [isize; 11] = [0, 1, 2, 4, 6, 7, 9, 11, 12, 14, 15];
/// POSIX EBUSY: macOS refuses a scan while its own scan or auto-join runs.
const SCAN_BUSY: isize = 16;

/// Answer one backend request with `{"result": ...}` or `{"error": "..."}`.
pub fn handle(request: &str) -> String {
	let reply = match autoreleasepool(|_| run(request)) {
		Ok(result) => json!({ "result": result }),
		Err(error) => json!({ "error": error }),
	};
	reply.to_string()
}

fn run(text: &str) -> Result<Value, String> {
	let request: Value =
		serde_json::from_str(text).map_err(|_| "macOS Wi-Fi request is invalid".to_string())?;
	let client: Option<Object> = unsafe { msg_send![class(c"CWWiFiClient")?, sharedWiFiClient] };
	let client = client.ok_or("macOS Wi-Fi is unavailable")?;
	match request["operation"].as_str() {
		Some("state") => state(&client),
		Some("scan") => {
			let iface = interface(&client, &request)?;
			let networks = scan(&iface, None)?
				.into_iter()
				.map(|(_, network)| network)
				.collect::<Vec<_>>();
			Ok(json!({ "snapshot": snapshot(&iface), "networks": networks }))
		}
		Some("associate") => associate(&*interface(&client, &request)?, &request).map(|_| Value::Null),
		Some("disconnect") => disconnect(&*interface(&client, &request)?).map(|_| Value::Null),
		_ => Err("Unsupported macOS Wi-Fi operation".into()),
	}
}

fn class(name: &CStr) -> Result<&'static AnyClass, String> {
	AnyClass::get(name).ok_or_else(|| format!("{} is unavailable", name.to_string_lossy()))
}

fn ns_string(value: &str) -> Result<Object, String> {
	let text = CString::new(value).map_err(|_| "macOS Wi-Fi text contains NUL".to_string())?;
	let string: Option<Object> =
		unsafe { msg_send![class(c"NSString")?, stringWithUTF8String: text.as_ptr()] };
	string.ok_or_else(|| "macOS Wi-Fi text is unavailable".into())
}

fn ns_data(bytes: &[u8]) -> Result<Object, String> {
	let data: Option<Object> = unsafe {
		msg_send![class(c"NSData")?, dataWithBytes: bytes.as_ptr() as *const c_void, length: bytes.len()]
	};
	data.ok_or_else(|| "macOS Wi-Fi data is unavailable".into())
}

fn text(object: Option<&AnyObject>) -> Option<String> {
	let raw: *const c_char = unsafe { msg_send![object?, UTF8String] };
	(!raw.is_null()).then(|| {
		unsafe { CStr::from_ptr(raw) }
			.to_string_lossy()
			.into_owned()
	})
}

fn hex(data: Option<&AnyObject>) -> Option<String> {
	let data = data?;
	let length: usize = unsafe { msg_send![data, length] };
	let bytes: *const c_void = unsafe { msg_send![data, bytes] };
	if length == 0 || bytes.is_null() {
		return None;
	}
	let bytes = unsafe { std::slice::from_raw_parts(bytes as *const u8, length) };
	Some(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn unhex(value: &str) -> Option<Vec<u8>> {
	if value.len() % 2 != 0 {
		return None;
	}
	(0..value.len())
		.step_by(2)
		.map(|i| u8::from_str_radix(value.get(i..i + 2)?, 16).ok())
		.collect()
}

fn error_code(error: &Option<Object>) -> Option<isize> {
	error
		.as_deref()
		.map(|error| unsafe { msg_send![error, code] })
}

fn failure(operation: &str, error: &Option<Object>) -> String {
	match error_code(error) {
		Some(code) => format!("macOS Wi-Fi {operation} failed (CoreWLAN error {code})"),
		None => format!("macOS Wi-Fi {operation} failed"),
	}
}

fn snapshot(iface: &AnyObject) -> Value {
	unsafe {
		let device: Option<Object> = msg_send![iface, interfaceName];
		let mode: isize = msg_send![iface, interfaceMode];
		let ssid: Option<Object> = msg_send![iface, ssidData];
		let bssid: Option<Object> = msg_send![iface, bssid];
		let security: isize = msg_send![iface, security];
		let signal: isize = msg_send![iface, rssiValue];
		let power: Bool = msg_send![iface, powerOn];
		json!({
			"device": text(device.as_deref()),
			"interfaceMode": mode,
			"ssidHex": hex(ssid.as_deref()),
			"bssid": text(bssid.as_deref()).map(|bssid| bssid.to_lowercase()),
			"securityType": security,
			"signal": signal,
			"powerOn": power.as_bool(),
		})
	}
}

/// Mixed CoreWLAN enums also match a single constituent; mirrors `coreWlanSecurityType`.
fn security_type(supported: &[isize]) -> isize {
	let has = |kind: isize| supported.contains(&kind);
	if [1, 6, 7, 9, 12, 14, 15].into_iter().any(has) {
		-1
	} else if has(11) {
		if has(4) {
			13
		} else {
			11
		}
	} else if has(4) {
		if has(2) {
			3
		} else {
			4
		}
	} else if has(2) {
		2
	} else if has(0) {
		0
	} else {
		-1
	}
}

fn scan(iface: &AnyObject, ssid: Option<&[u8]>) -> Result<Vec<(Object, Value)>, String> {
	let filter = ssid.map(ns_data).transpose()?;
	let mut attempt = 0;
	let found = loop {
		let mut error: Option<Object> = None;
		let set: Option<Object> =
			unsafe { msg_send![iface, scanForNetworksWithSSID: filter.as_deref(), error: &mut error] };
		if let Some(set) = set {
			break set;
		}
		attempt += 1;
		if attempt >= 5 || error_code(&error) != Some(SCAN_BUSY) {
			return Err(failure("scan", &error));
		}
		std::thread::sleep(Duration::from_secs(1));
	};
	let all: Option<Object> = unsafe { msg_send![&*found, allObjects] };
	let all = all.ok_or("macOS Wi-Fi scan returned nothing")?;
	let count: usize = unsafe { msg_send![&*all, count] };
	let mut networks = Vec::with_capacity(count);
	for index in 0..count {
		let network: Option<Object> = unsafe { msg_send![&*all, objectAtIndex: index] };
		let Some(network) = network else { continue };
		let supported: Vec<isize> = SECURITY_PROBES
			.into_iter()
			.filter(|kind| {
				let supports: Bool = unsafe { msg_send![&*network, supportsSecurity: *kind] };
				supports.as_bool()
			})
			.collect();
		let (ssid, bssid, signal) = unsafe {
			let ssid: Option<Object> = msg_send![&*network, ssidData];
			let bssid: Option<Object> = msg_send![&*network, bssid];
			let signal: isize = msg_send![&*network, rssiValue];
			(
				hex(ssid.as_deref()),
				text(bssid.as_deref()).map(|bssid| bssid.to_lowercase()),
				signal,
			)
		};
		let raw = json!({ "ssidHex": ssid, "bssid": bssid, "securityType": security_type(&supported), "signal": signal });
		networks.push((network, raw));
	}
	Ok(networks)
}

fn interface(client: &AnyObject, request: &Value) -> Result<Object, String> {
	let name = ns_string(
		request["device"]
			.as_str()
			.ok_or("macOS Wi-Fi interface is unavailable")?,
	)?;
	let iface: Option<Object> = unsafe { msg_send![client, interfaceWithName: &*name] };
	let iface = iface.ok_or("macOS Wi-Fi interface is unavailable")?;
	let power: Bool = unsafe { msg_send![&*iface, powerOn] };
	if !power.as_bool() {
		return Err("macOS Wi-Fi radio is off".into());
	}
	Ok(iface)
}

fn state(client: &AnyObject) -> Result<Value, String> {
	let interfaces: Option<Object> = unsafe { msg_send![client, interfaces] };
	let Some(interfaces) = interfaces else {
		return Ok(json!([]));
	};
	let count: usize = unsafe { msg_send![&*interfaces, count] };
	let mut result = Vec::with_capacity(count);
	for index in 0..count {
		let iface: Option<Object> = unsafe { msg_send![&*interfaces, objectAtIndex: index] };
		let Some(iface) = iface else { continue };
		let mut current = snapshot(&iface);
		let mut networks = Vec::new();
		if current["powerOn"] == true && current["ssidHex"].is_null() {
			// A refused scan leaves name access unknown; the radio state is still valid.
			if let Ok(found) = scan(&iface, None) {
				networks = found.into_iter().map(|(_, network)| network).collect();
				current = snapshot(&iface);
			}
		}
		result.push(json!({ "snapshot": current, "networks": networks }));
	}
	Ok(Value::Array(result))
}

/// Strength of a personal CWSecurity mode, the weakest constituent for a mixed one; open is 0.
fn security_rank(kind: i64) -> Option<u8> {
	match kind {
		0 => Some(0),
		2 | 3 => Some(1),
		4 | 13 => Some(2),
		11 => Some(3),
		_ => None,
	}
}

/// Mirrors `coreWlanAssociationMatches`: macOS moves to a stronger access point of the same network
/// within seconds of joining, so the raw SSID must match and the mode may only be as strong or stronger.
fn association_matches(actual: &Value, ssid_hex: &str, security: isize) -> bool {
	let (Some(floor), Some(rank)) = (
		security_rank(security as i64),
		actual["securityType"].as_i64().and_then(security_rank),
	) else {
		return false;
	};
	actual["ssidHex"].as_str() == Some(ssid_hex) && if floor == 0 { rank == 0 } else { rank >= floor }
}

/// Reject every ambiguous scan before choosing the strongest access point; mirrors `selectCoreWlanTarget`.
fn select<'a>(
	candidates: &'a [(Object, Value)],
	ssid_hex: &str,
	security: isize,
	bssid: Option<&str>,
) -> Result<&'a (Object, Value), String> {
	let targets: Vec<&(Object, Value)> = candidates
		.iter()
		.filter(|(_, network)| {
			bssid.is_none_or(|bssid| {
				network["bssid"]
					.as_str()
					.is_some_and(|found| found.eq_ignore_ascii_case(bssid))
			})
		})
		.collect();
	if targets.is_empty() {
		return Err("macOS Wi-Fi network is no longer available".into());
	}
	if bssid.is_some() && targets.len() != 1 {
		return Err("macOS Wi-Fi access point identity is ambiguous".into());
	}
	for (_, network) in &targets {
		if network["ssidHex"].as_str() != Some(ssid_hex) {
			return Err("macOS cannot identify the requested Wi-Fi network".into());
		}
		if network["securityType"].as_i64() != Some(security as i64) {
			return Err("macOS Wi-Fi security changed or the network name is ambiguous".into());
		}
	}
	Ok(
		targets
			.into_iter()
			.reduce(|best, item| {
				if item.1["signal"].as_i64() > best.1["signal"].as_i64() {
					item
				} else {
					best
				}
			})
			.expect("targets is not empty"),
	)
}

fn associate(iface: &AnyObject, request: &Value) -> Result<(), String> {
	let ssid_hex = request["ssidHex"]
		.as_str()
		.ok_or("macOS cannot identify the requested Wi-Fi network")?;
	let ssid = unhex(ssid_hex)
		.filter(|ssid| (1..=32).contains(&ssid.len()))
		.ok_or("macOS cannot identify the requested Wi-Fi network")?;
	let security = request["securityType"]
		.as_i64()
		.ok_or("macOS Wi-Fi authentication method is not supported")? as isize;
	let bssid = request["bssid"].as_str();
	let password = request["password"].as_str().unwrap_or("");
	let candidates = scan(iface, Some(&ssid))?;
	let (network, _) = select(&candidates, ssid_hex, security, bssid)?;
	if snapshot(iface)["ssidHex"].as_str() == Some(ssid_hex) {
		return Err("macOS is already connected to that Wi-Fi network".into());
	}
	// The selected CWNetwork retains its BSSID. Never issue a name-only join.
	let key = if security == 0 {
		None
	} else {
		Some(ns_string(password)?)
	};
	let mut error: Option<Object> = None;
	let joined: Bool = unsafe {
		msg_send![iface, associateToNetwork: &**network, password: key.as_deref(), error: &mut error]
	};
	if !joined.as_bool() {
		return Err(failure("association", &error));
	}
	if !association_matches(&snapshot(iface), ssid_hex, security) {
		return Err(
			"macOS did not connect to the requested Wi-Fi network with the requested security".into(),
		);
	}
	Ok(())
}

fn disconnect(iface: &AnyObject) -> Result<(), String> {
	if snapshot(iface)["interfaceMode"] != 1 {
		return Err("macOS Wi-Fi interface is not connected as a station".into());
	}
	let _: () = unsafe { msg_send![iface, disassociate] };
	// CoreWLAN has a void disconnect API; allow five seconds for the radio state to settle.
	for _ in 0..50 {
		let current = snapshot(iface);
		if current["interfaceMode"] == 0 && current["ssidHex"].is_null() && current["bssid"].is_null() {
			return Ok(());
		}
		std::thread::sleep(Duration::from_millis(100));
	}
	Err("macOS did not confirm Wi-Fi disconnection".into())
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn security_type_matches_the_backend_rules() {
		assert_eq!(security_type(&[4, 11]), 13);
		assert_eq!(security_type(&[2, 4]), 3);
		assert_eq!(security_type(&[11]), 11);
		assert_eq!(security_type(&[0]), 0);
		assert_eq!(security_type(&[4, 6]), -1);
	}

	#[test]
	fn association_accepts_a_stronger_mode_but_never_a_weaker_or_open_one() {
		let wpa3 = json!({ "ssidHex": "41", "securityType": 11 });
		assert!(association_matches(&wpa3, "41", 13));
		assert!(association_matches(&wpa3, "41", 4));
		assert!(!association_matches(&wpa3, "42", 4));
		assert!(!association_matches(
			&json!({ "ssidHex": "41", "securityType": 4 }),
			"41",
			11
		));
		assert!(!association_matches(
			&json!({ "ssidHex": "41", "securityType": 0 }),
			"41",
			4
		));
		assert!(!association_matches(
			&json!({ "ssidHex": "41", "securityType": 4 }),
			"41",
			0
		));
	}

	#[test]
	fn hex_round_trips_raw_bytes() {
		assert_eq!(unhex("4120ff"), Some(vec![0x41, 0x20, 0xff]));
		assert_eq!(unhex("4"), None);
	}
}
