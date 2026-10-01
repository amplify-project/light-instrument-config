use serialport;
use std::time::Duration;
use std::io::Write;
use std::sync::{Mutex, Arc};
use std::sync::atomic::{AtomicBool, Ordering};
use std::collections::HashMap;
use tauri::{State, AppHandle, Emitter, Manager};

struct PortEntry {
    port: Box<dyn serialport::SerialPort>,
    stop_signal: Arc<AtomicBool>,
}

struct SerialState {
    ports: Mutex<HashMap<String, PortEntry>>,
}

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn list_ports() -> Vec<String> {
    match serialport::available_ports() {
        Ok(ports) => ports.into_iter().map(|p| p.port_name).collect(),
        Err(_) => vec![],
    }
}

#[tauri::command]
fn open_port(state: State<'_, SerialState>, app: AppHandle, port_name: String) -> Result<(), String> {
    let mut ports = state.ports.lock().unwrap();
    if ports.contains_key(&port_name) {
        return Ok(());
    }

    let port = serialport::new(port_name.clone(), 460_800)
        .timeout(Duration::from_millis(100))
        .open()
        .map_err(|e| e.to_string())?;

    let stop_signal = Arc::new(AtomicBool::new(false));
    let thread_stop_signal = stop_signal.clone();

    ports.insert(port_name.clone(), PortEntry { 
        port: port.try_clone().map_err(|e| e.to_string())?,
        stop_signal 
    });
    
    let p_name = port_name.clone();
    std::thread::spawn(move || {
        loop {
            if thread_stop_signal.load(Ordering::SeqCst) {
                break;
            }

            {
                let state = app.state::<SerialState>();
                let mut ports_lock = state.ports.lock().unwrap();
                if let Some(entry) = ports_lock.get_mut(&p_name) {
                    let mut buffer = [0; 1024];
                    // We use a short timeout for the monitoring read to not block commands for too long
                    match entry.port.read(&mut buffer) {
                        Ok(t) if t > 0 => {
                            let data = String::from_utf8_lossy(&buffer[..t]).to_string();
                            let _ = app.emit("serial-data", serde_json::json!({ "port": p_name, "data": data }));
                        }
                        Ok(_) => {}
                        Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {}
                        Err(_) => {
                            ports_lock.remove(&p_name);
                            let _ = app.emit("serial-disconnected", serde_json::json!({ "port": p_name }));
                            break;
                        }
                    }
                } else {
                    break;
                }
            }
            
            std::thread::sleep(Duration::from_millis(100));
        }
    });

    Ok(())
}

#[tauri::command]
fn close_port(state: State<'_, SerialState>, port_name: String) {
    let mut ports = state.ports.lock().unwrap();
    if let Some(entry) = ports.remove(&port_name) {
        entry.stop_signal.store(true, Ordering::SeqCst);
    }
}

#[tauri::command]
fn get_settings(state: State<'_, SerialState>, app: AppHandle, port_name: String) -> Result<String, String> {
    let mut ports = state.ports.lock().unwrap();
    if let Some(entry) = ports.get_mut(&port_name) {
        let _ = entry.port.clear(serialport::ClearBuffer::Input);
        if let Err(e) = entry.port.write_all(b"getsettings\n") {
            let err_msg = e.to_string();
            ports.remove(&port_name);
            let _ = app.emit("serial-disconnected", serde_json::json!({ "port": port_name }));
            return Err(err_msg);
        }
        
        std::thread::sleep(Duration::from_millis(100));
        
        let mut buffer = [0; 1024];
        match entry.port.read(&mut buffer) {
            Ok(t) => Ok(String::from_utf8_lossy(&buffer[..t]).trim().to_string()),
            Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => Ok("".to_string()),
            Err(e) => {
                let err_msg = e.to_string();
                ports.remove(&port_name);
                let _ = app.emit("serial-disconnected", serde_json::json!({ "port": port_name }));
                Err(err_msg)
            }
        }
    } else {
        Err("Port not open".to_string())
    }
}

#[tauri::command]
fn update_setting(state: State<'_, SerialState>, app: AppHandle, port_name: String, key: String, value: String) -> Result<(), String> {
    let mut ports = state.ports.lock().unwrap();
    if let Some(entry) = ports.get_mut(&port_name) {
        let _ = entry.port.clear(serialport::ClearBuffer::Input);
        let command = format!("{}={}\n", key, value);
        if let Err(e) = entry.port.write_all(command.as_bytes()) {
            let err_msg = e.to_string();
            ports.remove(&port_name);
            let _ = app.emit("serial-disconnected", serde_json::json!({ "port": port_name }));
            return Err(err_msg);
        }
        
        std::thread::sleep(Duration::from_millis(100));
        
        let mut buffer = [0; 1024];
        match entry.port.read(&mut buffer) {
            Ok(t) => {
                let response = String::from_utf8_lossy(&buffer[..t]).trim().to_string();
                if response == "OK" {
                    Ok(())
                } else if response == "ERR" {
                    Err("Device returned ERR".to_string())
                } else {
                    Err(format!("Device returned unexpected response: {}", response))
                }
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => Err("Timed out waiting for device response".to_string()),
            Err(e) => {
                let err_msg = e.to_string();
                ports.remove(&port_name);
                let _ = app.emit("serial-disconnected", serde_json::json!({ "port": port_name }));
                Err(err_msg)
            }
        }
    } else {
        Err("Port not open".to_string())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(SerialState {
            ports: Mutex::new(HashMap::new()),
        })
        .invoke_handler(tauri::generate_handler![
            list_ports,
            open_port,
            close_port,
            get_settings,
            update_setting
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
