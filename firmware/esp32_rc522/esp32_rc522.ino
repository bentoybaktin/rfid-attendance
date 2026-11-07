
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <SPI.h>
#include <MFRC522.h>
#include <string.h>
#include <time.h>
#include "secrets.h"

#define SS_PIN   5
#define RST_PIN  22
#define LED_OK   25
#define LED_ERR  26
#define BUZZER   27

MFRC522 rfid(SS_PIN, RST_PIN);

struct Pending { String uid; String ts; };
const int QMAX = 50;
Pending queue[QMAX];
int qLen = 0;

String lastUid = "";
String lastResponseBody = "";
unsigned long lastUidMs = 0;
unsigned long lastFlushMs = 0;

void signal(bool ok) {
  digitalWrite(ok ? LED_OK : LED_ERR, HIGH);
  int beeps = ok ? 1 : 3;
  for (int i = 0; i < beeps; i++) {
    digitalWrite(BUZZER, HIGH); delay(ok ? 120 : 80);
    digitalWrite(BUZZER, LOW);  delay(60);
  }
  delay(200);
  digitalWrite(LED_OK, LOW);
  digitalWrite(LED_ERR, LOW);
}


String nowTs() {
  struct tm t;
  if (!getLocalTime(&t, 50)) return "";
  char b[24];
  strftime(b, sizeof(b), "%Y-%m-%dT%H:%M:%S", &t);
  return String(b);
}

void connectWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 8000) delay(200);
}


int postTap(const String& uid, const String& ts) {
  lastResponseBody = "";
  if (WiFi.status() != WL_CONNECTED) return -1;
  if (!SERVER_URL ||
      strncmp(SERVER_URL, "https://", 8) != 0 ||
      !SERVER_ROOT_CA ||
      !SERVER_ROOT_CA[0] ||
      !DEVICE_KEY ||
      !DEVICE_KEY[0] ||
      strcmp(DEVICE_KEY, "REPLACE_WITH_DEVICE_KEY") == 0) {
    Serial.println("RFID POST blocked: configure HTTPS, its root CA, and DEVICE_KEY in secrets.h.");
    return -1;
  }
  if (time(nullptr) < 1700000000) {
    Serial.println("RFID POST blocked: waiting for network time before validating the TLS certificate.");
    return -1;
  }
  WiFiClientSecure secureClient;
  secureClient.setCACert(SERVER_ROOT_CA);
  HTTPClient http;
  http.setTimeout(4000);
  if (!http.begin(secureClient, SERVER_URL)) return -1;
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-device-key", DEVICE_KEY);
  String body = "{\"uid\":\"" + uid + "\"";
  if (ts.length()) body += ",\"ts\":\"" + ts + "\"";
  body += "}";
  int code = http.POST(body);
  if (code > 0) lastResponseBody = http.getString();
  http.end();
  return code > 0 ? code : -1;
}

void flushQueue() {
  while (qLen > 0) {
    int code = postTap(queue[0].uid, queue[0].ts);
    if (code < 0) return;  

    // Any HTTP answer (200 ok, 404 unknown card, 409 duplicate) means the server handled it.
    for (int i = 1; i < qLen; i++) queue[i - 1] = queue[i];
    qLen--;
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_OK, OUTPUT);
  pinMode(LED_ERR, OUTPUT);
  pinMode(BUZZER, OUTPUT);

  SPI.begin();
  rfid.PCD_Init();

  connectWifi();
  configTime(8 * 3600, 0, "pool.ntp.org", "time.google.com");  // UTC+8, no DST
  Serial.println(WiFi.status() == WL_CONNECTED ? "Wi-Fi connected" : "Wi-Fi not connected (offline mode)");
  signal(true);
}

void loop() {
  connectWifi();

  if (millis() - lastFlushMs > 10000) {
    lastFlushMs = millis();
    flushQueue();
  }

  if (!rfid.PICC_IsNewCardPresent() || !rfid.PICC_ReadCardSerial()) return;

  String uid = "";
  for (byte i = 0; i < rfid.uid.size; i++) {
    if (rfid.uid.uidByte[i] < 0x10) uid += "0";
    uid += String(rfid.uid.uidByte[i], HEX);
  }
  uid.toUpperCase();
  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();

  if (uid == lastUid && millis() - lastUidMs < 2000) return;
  lastUid = uid;
  lastUidMs = millis();

  String ts = nowTs();
  Serial.println("Tap: " + uid + " " + ts);

  int code = postTap(uid, "");  
  if (code < 0) {
    if (qLen < QMAX) queue[qLen++] = { uid, ts };
    signal(true);  
    return;
  }
  if (lastResponseBody.length()) Serial.println("Reader response: " + lastResponseBody);
  signal(code == 200);
}
