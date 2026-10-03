import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";

function App() {
  const [ports, setPorts] = useState<string[]>([]);
  const [selectedPort, setSelectedPort] = useState("");
  const [isConnected, setIsConnected] = useState(false);
  const [settings, setSettings] = useState<{ key: string; value: string }[]>([]);
  const [originalSettings, setOriginalSettings] = useState<Record<string, string>>({});
  const [status, setStatus] = useState("");

  async function refreshPorts() {
    try {
      const availablePorts = await invoke<string[]>("list_ports");
      setPorts(availablePorts);

      if (availablePorts.length > 0 && !selectedPort) {
        setSelectedPort(availablePorts[0]);
      }
    } catch (err) {
      setStatus(`Error listing ports: ${err}`);
    }
  }

  async function fetchSettings(port: string) {
    try {
      const response = await invoke<string>("get_settings", { portName: port });
      if (response) {
        const parsedSettings = response.split(',').map(s => {
          const [key, value] = s.split('=');
          return { key: key?.trim() || "", value: value?.trim() || "" };
        }).filter(s => s.key);
        setSettings(parsedSettings);

        const originals: Record<string, string> = {};
        parsedSettings.forEach(s => originals[s.key] = s.value);
        setOriginalSettings(originals);
        return true;
      }
      return false;
    } catch (err) {
      console.error("Error fetching settings:", err);
      return false;
    }
  }

  async function toggleConnection() {
    if (isConnected) {
      try {
        await invoke("close_port", { portName: selectedPort });
        setIsConnected(false);
        setSettings([]);
        setOriginalSettings({});
        setStatus("Disconnected");
      } catch (err) {
        setStatus(`Error closing port: ${err}`);
      }
    } else {
      if (!selectedPort) {
        setStatus("Please select a port");
        return;
      }
      setStatus("Connecting...");
      try {
        await invoke("open_port", { portName: selectedPort });
        setIsConnected(true);
        setStatus("Connected. Fetching settings...");

        const success = await fetchSettings(selectedPort);
        if (success) {
          setStatus("Connected");
        } else {
          setStatus("Connected (No settings found)");
        }
      } catch (err) {
        setStatus(`Error: ${err}`);
      }
    }
  }

  function handleValueChange(index: number, newValue: string) {
    const newSettings = [...settings];
    newSettings[index].value = newValue;
    setSettings(newSettings);
  }

  function getDirtySettings() {
    return settings.filter(s => s.key !== 'type' && s.value !== originalSettings[s.key]);
  }

  async function handleReboot() {
    try {
      await invoke("reboot_device", { portName: selectedPort });
      await toggleConnection();
    } catch (err) {
      console.error(err);
    }
  }

  async function handleApplyAll() {
    const dirtySettings = getDirtySettings();

    if (dirtySettings.length === 0) {
      setStatus("No changes to apply");
      return;
    }

    setStatus(`Updating ${dirtySettings.length} settings...`);
    let successCount = 0;
    let errorCount = 0;

    for (const s of dirtySettings) {
      try {
        await invoke("update_setting", { portName: selectedPort, key: s.key, value: s.value });
        successCount++;
      } catch (err) {
        console.error(`Error updating ${s.key}:`, err);
        errorCount++;
      }
    }

    setStatus("Refreshing settings...");
    await fetchSettings(selectedPort);

    if (errorCount === 0) {
      setStatus(`Success: ${successCount} value${(successCount == 1) ? "" : "s"} updated`);
    } else {
      setStatus(`Updated ${successCount} value${(successCount == 1) ? "" : "s"}, ${errorCount} failed`);
    }
  }

  useEffect(() => {
    refreshPorts();
  }, []);

  useEffect(() => {
    const unlisten = listen<{ port: string }>("serial-disconnected", (event) => {
      if (isConnected && selectedPort === event.payload.port) {
        setIsConnected(false);
        setSettings([]);
        setOriginalSettings({});
        setStatus(`Port ${event.payload.port} disconnected`);
      }
    });

    return () => {
      unlisten.then((f) => f());
    };
  }, [isConnected, selectedPort]);

  return (
    <>
      <svg style={{ backgroundColor: "#121212", position: "absolute", width: "100%", height: "100%", top: 0, left: 0 }}>
        <pattern id="pattern-1" x="8.137809187279117" y="20.863957597173147" width="23.14487632508834" height="23.14487632508834" patternUnits="userSpaceOnUse" patternTransform="translate(-12.57243816254417,-12.57243816254417)">
          <circle cx="0.5786219081272085" cy="0.5786219081272085" r="0.5786219081272085" style={{ fill: "rgb(51, 51, 51)" }}></circle>
        </pattern>
        <rect x="0" y="0" width="100%" height="100%" fill="url(#pattern-1)"></rect>
      </svg>

      <main className="container">
        <div className="content-wrapper">
          <div className="row">
            <label htmlFor="port-select">Serial Port: </label>
            <select
              id="port-select"
              value={selectedPort}
              onChange={(e) => setSelectedPort(e.target.value)}
              disabled={isConnected}
            >
              {ports.length === 0 && <option value="">No ports found</option>}
              {ports.map((port) => (
                <option key={port} value={port}>
                  {port}
                </option>
              ))}
            </select>
            <button onClick={refreshPorts} disabled={isConnected}>Refresh</button>
            <button onClick={toggleConnection} className={isConnected ? "disconnect-btn" : "connect-btn"}>
              {isConnected ? "Disconnect" : "Connect"}
            </button>
          </div>

          {status && <p className={`status ${isConnected ? "connected" : ""}`}>{status}</p>}

          {isConnected && settings.length > 0 && (
            <div className="settings-container">
              <div className="settings-list">
                {settings.map((setting, index) => (
                  <div key={index} className="setting-item">
                    <span className="setting-key">{setting.key}:</span>
                    {setting.key === "type" ? (
                      <span className="setting-value">{setting.value}</span>
                    ) : (
                      <div className="setting-edit-group">
                        <input
                          className="setting-input"
                          value={setting.value}
                          onChange={(e) => handleValueChange(index, e.target.value)}
                        />
                      </div>
                    )}
                  </div>
                ))}
              </div>

              <div className="settings-actions">
                <button className="apply-btn" onClick={handleApplyAll}>
                  Apply Changes
                </button>
                <button className="reboot-btn" onClick={handleReboot}>
                  Reboot
                </button>
              </div>
            </div>
          )}
        </div>
      </main>
    </>
  );
}

export default App;
