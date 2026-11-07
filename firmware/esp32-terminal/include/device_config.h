#pragma once

#define DEVICE_ID "TERM-01"
#define FIRMWARE_VERSION "esp32-terminal-1.0.0"

// ESP32 DevKit V1 / WROOM-32 defaults. Change these for another board.
constexpr int PIN_ALARM_BUTTON = 27;  // button to GND, internal pull-up enabled
constexpr int PIN_WARNING_LED = 26;   // LED through 220 ohm, or MOSFET module input
constexpr int PIN_DHT22 = 25;

constexpr unsigned long STATUS_INTERVAL_MS = 1000;
constexpr unsigned long PROBE_INTERVAL_MS = 100;   // 10 packets per second
constexpr unsigned long METRIC_INTERVAL_MS = 1000;
constexpr unsigned long COMMAND_DEDUP_TTL_MS = 300000;
constexpr int MQTT_PORT = 1883;
constexpr int PROBE_PAYLOAD_BYTES = 128;
