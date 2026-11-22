#pragma once
#include <stdbool.h>
#include <stdint.h>
#include "esp_netif.h"
#include "esp_http_server.h"
#include "wifi_profiles.h"

typedef struct {
    bool online;
    bool relay;
    bool scanning;
    int rssi;
    unsigned generation;
    char ssid[33];
} demo_network_state_t;

void demo_network_start(bool repeater);
demo_network_state_t demo_network_state(void);
void demo_network_upload_result(bool success, unsigned generation);
/* User-paused video is idle, not an acknowledged frame or a failed link. */
void demo_network_upload_idle(unsigned generation);
void demo_network_force_route(int mode); /* 0 自动，1 直连，2 中继 */
int demo_network_force_mode(void);
esp_netif_t *demo_network_sta(void);
const char *demo_relay_ssid(void);

typedef struct {
    bool active, testing;
    unsigned remaining_s, saved_count;
    char hotspot[33], ip[16], message[128];
    char saved_ssids[DEMO_SAVED_NETWORKS][33];
} demo_setup_status_t;
demo_setup_status_t demo_network_setup_status(void);
void demo_network_setup_touch(void);
/* Returns false if invalid, setup closed, or another candidate is being tested. */
bool demo_network_submit_profile(const demo_wifi_profile_t *profile);
void demo_network_register_portal(httpd_handle_t server);
void demo_portal_dns_start(void);
