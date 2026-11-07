#include <Arduino.h>
#include <ArduinoJson.h>
#include <DHT.h>
#include <PubSubClient.h>
#include <WiFi.h>
#include "device_config.h"
#include "secrets.h"

WiFiClient networkClient;
PubSubClient mqtt(networkClient);
DHT dht(PIN_DHT22, DHT22);

enum class LinkMode { Direct, Relay };
LinkMode currentMode = LinkMode::Relay;
LinkMode requestedMode = LinkMode::Relay;
bool lampOn = false;
bool alarmActive = false;
bool reconnectRequested = false;
uint32_t statusSequence = 0;
uint32_t probeSequence = 0;
unsigned long lastStatusAt = 0;
unsigned long lastProbeAt = 0;
unsigned long lastMetricAt = 0;
unsigned long buttonPressedAt = 0;
bool lastButtonState = HIGH;

struct PendingProbe { uint32_t sequence; unsigned long sentAt; bool active; };
PendingProbe pending[20] = {};
uint16_t rttSamples[20] = {};
uint8_t rttCount = 0;
uint16_t sentInWindow = 0;
uint16_t receivedInWindow = 0;
uint16_t duplicateInWindow = 0;

struct HandledCommand { String id; unsigned long handledAt; };
HandledCommand handledCommands[12];
uint8_t handledCursor = 0;

const char* modeName(LinkMode mode) { return mode == LinkMode::Relay ? "relay" : "direct"; }
const char* wifiSsid(LinkMode mode) { return mode == LinkMode::Relay ? RELAY_WIFI_SSID : DIRECT_WIFI_SSID; }
const char* wifiPassword(LinkMode mode) { return mode == LinkMode::Relay ? RELAY_WIFI_PASSWORD : DIRECT_WIFI_PASSWORD; }
const char* mqttHost(LinkMode mode) { return mode == LinkMode::Relay ? RELAY_MQTT_HOST : DIRECT_MQTT_HOST; }
const char* upstreamName(LinkMode mode) { return mode == LinkMode::Relay ? "RELAY-01" : "CONTROL-01"; }

void publishJson(const String& topic, JsonDocument& document, bool retained = false) {
  char payload[1024];
  const size_t length = serializeJson(document, payload, sizeof(payload));
  mqtt.publish(topic.c_str(), reinterpret_cast<const uint8_t*>(payload), length, retained);
}

bool wasHandled(const String& commandId) {
  const unsigned long now = millis();
  for (const auto& item : handledCommands) {
    if (item.id == commandId && now - item.handledAt < COMMAND_DEDUP_TTL_MS) return true;
  }
  return false;
}

void rememberCommand(const String& commandId) {
  handledCommands[handledCursor] = { commandId, millis() };
  handledCursor = (handledCursor + 1) % 12;
}

void publishCommandAck(const String& commandId, bool ok, const char* error = nullptr, bool duplicate = false) {
  JsonDocument document;
  document["commandId"] = commandId;
  document["ok"] = ok;
  document["duplicate"] = duplicate;
  if (error) document["error"] = error;
  publishJson("relay/" DEVICE_ID "/ack", document);
}

void changeMode(LinkMode nextMode) {
  if (requestedMode == nextMode && currentMode == nextMode) return;
  requestedMode = nextMode;
  reconnectRequested = true;
}

void onMqttMessage(char* topic, byte* payload, unsigned int length) {
  JsonDocument document;
  if (deserializeJson(document, payload, length)) return;
  const String topicName(topic);

  if (topicName == "relay/system/mode") {
    const String mode = document["mode"] | "";
    if (mode == "direct") changeMode(LinkMode::Direct);
    if (mode == "relay") changeMode(LinkMode::Relay);
    return;
  }

  if (topicName == "relay/" DEVICE_ID "/probe-ack") {
    const uint32_t sequence = document["sequence"] | 0;
    for (auto& probe : pending) {
      if (probe.active && probe.sequence == sequence) {
        if (rttCount < 20) rttSamples[rttCount++] = static_cast<uint16_t>(millis() - probe.sentAt);
        probe.active = false;
        receivedInWindow++;
        return;
      }
    }
    duplicateInWindow++;
    return;
  }

  if (topicName != "relay/" DEVICE_ID "/command") return;
  const String commandId = document["commandId"] | "";
  const String action = document["action"] | "";
  if (commandId.isEmpty()) return;
  if (wasHandled(commandId)) {
    publishCommandAck(commandId, true, nullptr, true);
    return;
  }

  bool ok = true;
  const char* error = nullptr;
  if (action == "lamp_on") lampOn = true;
  else if (action == "lamp_off") lampOn = false;
  else if (action == "alarm_reset") alarmActive = false;
  else { ok = false; error = "unsupported action"; }
  digitalWrite(PIN_WARNING_LED, lampOn ? HIGH : LOW);
  rememberCommand(commandId);
  publishCommandAck(commandId, ok, error);
}

void connectWifi() {
  WiFi.disconnect(true, true);
  delay(150);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(wifiSsid(requestedMode), wifiPassword(requestedMode));
  const unsigned long startedAt = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - startedAt < 15000) delay(250);
  currentMode = requestedMode;
}

void connectMqtt() {
  if (WiFi.status() != WL_CONNECTED) return;
  mqtt.setServer(mqttHost(currentMode), MQTT_PORT);
  const String clientId = String(DEVICE_ID) + "-" + String(static_cast<uint32_t>(ESP.getEfuseMac()), HEX);
  if (mqtt.connect(clientId.c_str(), MQTT_USERNAME, MQTT_PASSWORD)) {
    mqtt.subscribe("relay/" DEVICE_ID "/command", 1);
    mqtt.subscribe("relay/" DEVICE_ID "/probe-ack", 0);
    mqtt.subscribe("relay/system/mode", 1);
  }
}

void publishStatus() {
  JsonDocument document;
  document["nodeId"] = DEVICE_ID;
  document["role"] = "terminal";
  document["online"] = true;
  document["sequence"] = ++statusSequence;
  document["mode"] = modeName(currentMode);
  document["upstream"] = upstreamName(currentMode);
  document["downstream"] = nullptr;
  document["source"] = "measured";
  document["firmware"] = FIRMWARE_VERSION;
  document["rssi"] = WiFi.RSSI();
  document["lampOn"] = lampOn;
  document["alarm"] = alarmActive;
  const float temperature = dht.readTemperature();
  const float humidity = dht.readHumidity();
  if (!isnan(temperature)) document["temperature"] = temperature;
  if (!isnan(humidity)) document["humidity"] = humidity;
  publishJson("relay/" DEVICE_ID "/status", document);
}

void sendProbe() {
  const uint8_t slot = probeSequence % 20;
  pending[slot] = { ++probeSequence, millis(), true };
  sentInWindow++;
  String padding;
  padding.reserve(PROBE_PAYLOAD_BYTES);
  while (padding.length() < PROBE_PAYLOAD_BYTES) padding += 'P';
  JsonDocument document;
  document["sequence"] = probeSequence;
  document["sentAtMs"] = pending[slot].sentAt;
  document["payload"] = padding;
  publishJson("relay/" DEVICE_ID "/probe", document);
}

void publishMetric() {
  for (uint8_t i = 0; i < rttCount; i++) for (uint8_t j = i + 1; j < rttCount; j++) {
    if (rttSamples[j] < rttSamples[i]) { const uint16_t value = rttSamples[i]; rttSamples[i] = rttSamples[j]; rttSamples[j] = value; }
  }
  uint32_t total = 0;
  for (uint8_t i = 0; i < rttCount; i++) total += rttSamples[i];
  const uint16_t average = rttCount ? total / rttCount : 0;
  const uint16_t p95 = rttCount ? rttSamples[min<uint8_t>(rttCount - 1, static_cast<uint8_t>((rttCount * 95 + 99) / 100 - 1))] : 0;

  JsonDocument document;
  document["testId"] = String("FIELD-") + modeName(currentMode);
  document["sourceNode"] = DEVICE_ID;
  document["targetNode"] = "CONTROL-01";
  JsonArray path = document["path"].to<JsonArray>();
  path.add(DEVICE_ID);
  if (currentMode == LinkMode::Relay) path.add("RELAY-01");
  path.add("CONTROL-01");
  document["windowSeconds"] = 1;
  document["sent"] = sentInWindow;
  document["received"] = receivedInWindow;
  document["timedOut"] = sentInWindow - receivedInWindow;
  document["duplicates"] = duplicateInWindow;
  document["rttAvgMs"] = average;
  document["rttP95Ms"] = p95;
  document["goodputKbps"] = receivedInWindow * PROBE_PAYLOAD_BYTES * 8.0f / 1000.0f;
  document["forwardedPackets"] = currentMode == LinkMode::Relay ? receivedInWindow : 0;
  document["source"] = "measured";
  publishJson("relay/" DEVICE_ID "/metric", document);
  sentInWindow = receivedInWindow = duplicateInWindow = rttCount = 0;
}

void handleButton() {
  const bool state = digitalRead(PIN_ALARM_BUTTON);
  if (lastButtonState == HIGH && state == LOW) buttonPressedAt = millis();
  if (lastButtonState == LOW && state == HIGH) {
    const unsigned long duration = millis() - buttonPressedAt;
    if (duration >= 2500) changeMode(currentMode == LinkMode::Relay ? LinkMode::Direct : LinkMode::Relay);
    else if (duration >= 30) alarmActive = true;
  }
  lastButtonState = state;
}

void setup() {
  Serial.begin(115200);
  pinMode(PIN_ALARM_BUTTON, INPUT_PULLUP);
  pinMode(PIN_WARNING_LED, OUTPUT);
  digitalWrite(PIN_WARNING_LED, LOW);
  dht.begin();
  mqtt.setCallback(onMqttMessage);
  mqtt.setBufferSize(1536);
  mqtt.setKeepAlive(15);
  connectWifi();
  connectMqtt();
}

void loop() {
  handleButton();
  if (reconnectRequested) {
    reconnectRequested = false;
    mqtt.disconnect();
    connectWifi();
    connectMqtt();
  }
  if (WiFi.status() != WL_CONNECTED) { connectWifi(); connectMqtt(); }
  if (!mqtt.connected()) { connectMqtt(); delay(50); }
  mqtt.loop();
  const unsigned long now = millis();
  if (mqtt.connected() && now - lastProbeAt >= PROBE_INTERVAL_MS) { lastProbeAt = now; sendProbe(); }
  if (mqtt.connected() && now - lastStatusAt >= STATUS_INTERVAL_MS) { lastStatusAt = now; publishStatus(); }
  if (mqtt.connected() && now - lastMetricAt >= METRIC_INTERVAL_MS) { lastMetricAt = now; publishMetric(); }
  delay(2);
}
