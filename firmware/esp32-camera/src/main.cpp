#include <Arduino.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include "esp_camera.h"
#include "secrets.h"

// AI Thinker ESP32-CAM + OV2640 pin map.
constexpr int PWDN_GPIO_NUM = 32;
constexpr int RESET_GPIO_NUM = -1;
constexpr int XCLK_GPIO_NUM = 0;
constexpr int SIOD_GPIO_NUM = 26;
constexpr int SIOC_GPIO_NUM = 27;
constexpr int Y9_GPIO_NUM = 35;
constexpr int Y8_GPIO_NUM = 34;
constexpr int Y7_GPIO_NUM = 39;
constexpr int Y6_GPIO_NUM = 36;
constexpr int Y5_GPIO_NUM = 21;
constexpr int Y4_GPIO_NUM = 19;
constexpr int Y3_GPIO_NUM = 18;
constexpr int Y2_GPIO_NUM = 5;
constexpr int VSYNC_GPIO_NUM = 25;
constexpr int HREF_GPIO_NUM = 23;
constexpr int PCLK_GPIO_NUM = 22;
constexpr unsigned long FRAME_INTERVAL_MS = 1000;
unsigned long lastFrameAt = 0;

bool startCamera() {
  camera_config_t config = {};
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM; config.pin_d1 = Y3_GPIO_NUM; config.pin_d2 = Y4_GPIO_NUM; config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM; config.pin_d5 = Y7_GPIO_NUM; config.pin_d6 = Y8_GPIO_NUM; config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM; config.pin_pclk = PCLK_GPIO_NUM; config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM; config.pin_sccb_sda = SIOD_GPIO_NUM; config.pin_sccb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn = PWDN_GPIO_NUM; config.pin_reset = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;
  config.frame_size = FRAMESIZE_VGA; // 640x480, stable at 1 FPS
  config.jpeg_quality = psramFound() ? 12 : 16;
  config.fb_count = psramFound() ? 2 : 1;
  config.grab_mode = CAMERA_GRAB_LATEST;
  return esp_camera_init(&config) == ESP_OK;
}

void connectWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  const unsigned long startedAt = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - startedAt < 15000) delay(250);
}

void uploadFrame() {
  camera_fb_t* frame = esp_camera_fb_get();
  if (!frame) return;
  WiFiClient client;
  HTTPClient http;
  http.begin(client, FRAME_UPLOAD_URL);
  http.addHeader("Content-Type", "image/jpeg");
  http.addHeader("x-device-token", DEVICE_TOKEN);
  http.addHeader("x-frame-rate", "1");
  http.addHeader("x-frame-width", String(frame->width));
  http.addHeader("x-frame-height", String(frame->height));
  const int status = http.POST(frame->buf, frame->len);
  Serial.printf("frame bytes=%u status=%d\n", frame->len, status);
  http.end();
  esp_camera_fb_return(frame);
}

void setup() {
  Serial.begin(115200);
  connectWifi();
  if (!startCamera()) Serial.println("camera initialization failed");
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) connectWifi();
  const unsigned long now = millis();
  if (WiFi.status() == WL_CONNECTED && now - lastFrameAt >= FRAME_INTERVAL_MS) {
    lastFrameAt = now;
    uploadFrame();
  }
  delay(10);
}
