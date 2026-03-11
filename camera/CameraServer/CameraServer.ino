#include "esp_camera.h"
#include <WiFi.h>
#include "esp_http_server.h"

const char* ssid = "Amrita_CHN";
const char* password = "amrita@321";

httpd_handle_t server = NULL;

// AI Thinker camera pins
#define PWDN_GPIO_NUM     32
#define RESET_GPIO_NUM    -1
#define XCLK_GPIO_NUM      0
#define SIOD_GPIO_NUM     26
#define SIOC_GPIO_NUM     27

#define Y9_GPIO_NUM       35
#define Y8_GPIO_NUM       34
#define Y7_GPIO_NUM       39
#define Y6_GPIO_NUM       36
#define Y5_GPIO_NUM       21
#define Y4_GPIO_NUM       19
#define Y3_GPIO_NUM       18
#define Y2_GPIO_NUM        5

#define VSYNC_GPIO_NUM    25
#define HREF_GPIO_NUM     23
#define PCLK_GPIO_NUM     22

#define FLASH_GPIO_NUM     4   // AI Thinker onboard flash LED


static esp_err_t capture_handler(httpd_req_t *req) {

  Serial.println("Capture request received");

  camera_fb_t * fb = esp_camera_fb_get();

  if (!fb) {
    Serial.println("Camera capture failed");
    httpd_resp_send_500(req);
    return ESP_FAIL;
  }

  httpd_resp_set_type(req, "image/jpeg");
  httpd_resp_send(req, (const char *)fb->buf, fb->len);

  esp_camera_fb_return(fb);

  Serial.println("Image sent");

  return ESP_OK;
}


// ------------------------------------------------------------------
// MJPEG stream handler  (/stream)
// ------------------------------------------------------------------
static const char* STREAM_CONTENT_TYPE =
    "multipart/x-mixed-replace;boundary=frame";
static const char* STREAM_BOUNDARY = "--frame\r\n";
static const char* STREAM_PART =
    "Content-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n";

static esp_err_t stream_handler(httpd_req_t *req) {

  camera_fb_t *fb  = NULL;
  esp_err_t    res = ESP_OK;
  char         part_buf[128];

  httpd_resp_set_type(req, STREAM_CONTENT_TYPE);
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  httpd_resp_set_hdr(req, "Cache-Control", "no-cache");

  Serial.println("Stream started");

  while (true) {

    fb = esp_camera_fb_get();
    if (!fb) {
      Serial.println("Stream: capture failed");
      res = ESP_FAIL;
      break;
    }

    res = httpd_resp_send_chunk(req, STREAM_BOUNDARY,
                                strlen(STREAM_BOUNDARY));
    if (res == ESP_OK) {
      size_t hlen = snprintf(part_buf, sizeof(part_buf),
                             STREAM_PART, fb->len);
      res = httpd_resp_send_chunk(req, part_buf, hlen);
    }
    if (res == ESP_OK)
      res = httpd_resp_send_chunk(req, (const char *)fb->buf, fb->len);
    if (res == ESP_OK)
      res = httpd_resp_send_chunk(req, "\r\n", 2);

    esp_camera_fb_return(fb);

    if (res != ESP_OK) break;
  }

  Serial.println("Stream ended");
  return res;
}


// ------------------------------------------------------------------
// Flash LED toggle  (/flash)
// ------------------------------------------------------------------
static bool flash_on = false;

static esp_err_t flash_handler(httpd_req_t *req) {

  flash_on = !flash_on;
  digitalWrite(FLASH_GPIO_NUM, flash_on ? HIGH : LOW);

  httpd_resp_set_type(req, "application/json");
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");

  char buf[32];
  snprintf(buf, sizeof(buf), "{\"flash\":\"%s\"}",
           flash_on ? "on" : "off");
  httpd_resp_send(req, buf, strlen(buf));

  Serial.printf("Flash: %s\n", flash_on ? "ON" : "OFF");
  return ESP_OK;
}


void startServer() {

  httpd_config_t config = HTTPD_DEFAULT_CONFIG();

  if (httpd_start(&server, &config) == ESP_OK) {

    httpd_uri_t capture_uri = {
        .uri       = "/capture",
        .method    = HTTP_GET,
        .handler   = capture_handler,
        .user_ctx  = NULL
    };

    httpd_register_uri_handler(server, &capture_uri);

    httpd_uri_t stream_uri = {
        .uri       = "/stream",
        .method    = HTTP_GET,
        .handler   = stream_handler,
        .user_ctx  = NULL
    };
    httpd_register_uri_handler(server, &stream_uri);

    httpd_uri_t flash_uri = {
        .uri       = "/flash",
        .method    = HTTP_GET,
        .handler   = flash_handler,
        .user_ctx  = NULL
    };
    httpd_register_uri_handler(server, &flash_uri);

    Serial.println("HTTP server started");
  }
}


void connectWiFi() {

  Serial.println("Connecting to WiFi...");
  WiFi.begin(ssid, password);

  int retry = 0;

  while (WiFi.status() != WL_CONNECTED) {

    delay(500);
    Serial.print(".");

    retry++;

    if (retry > 40) {
      Serial.println("\nWiFi failed. Restarting...");
      ESP.restart();
    }
  }

  Serial.println("\nWiFi connected");
  Serial.print("IP: ");
  Serial.println(WiFi.localIP());
}


void setup() {

  Serial.begin(115200);
  Serial.println("Booting ESP32-CAM");

  connectWiFi();

  camera_config_t config;
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;

  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;

  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM;

  config.pin_sscb_sda = SIOD_GPIO_NUM;
  config.pin_sscb_scl = SIOC_GPIO_NUM;

  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;

  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;

  config.frame_size = FRAMESIZE_VGA;
  config.jpeg_quality = 12;
  config.fb_count = 1;

  Serial.println("Initializing camera...");

  if (esp_camera_init(&config) != ESP_OK) {
    Serial.println("Camera init failed");
    return;
  }

  Serial.println("Camera ready");

  sensor_t * s = esp_camera_sensor_get();
  s->set_vflip(s, 1);
  s->set_hmirror(s, 1);

  pinMode(FLASH_GPIO_NUM, OUTPUT);
  digitalWrite(FLASH_GPIO_NUM, LOW);

  startServer();

  Serial.print("Endpoints: http://");
  Serial.print(WiFi.localIP());
  Serial.println("/capture  (JPEG snapshot)");
  Serial.print("           http://");
  Serial.print(WiFi.localIP());
  Serial.println("/stream   (MJPEG live stream)");
  Serial.print("           http://");
  Serial.print(WiFi.localIP());
  Serial.println("/flash    (toggle flash LED)");
}

void loop() {}