#pragma once
/* Portable profile validation/storage policy; no Wi-Fi or NVS dependency. */
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#define DEMO_SAVED_NETWORKS 6
#define DEMO_SETUP_PASSWORD "esp32demo"
#define DEMO_SETUP_WINDOW_MS 30000U
typedef struct { char ssid[33]; char password[65]; } demo_wifi_profile_t;
typedef struct {
    uint32_t version;
    uint32_t count;
    demo_wifi_profile_t items[DEMO_SAVED_NETWORKS];
} demo_wifi_profiles_t;

static inline bool demo_profile_valid(const demo_wifi_profile_t *p) {
    size_t s = strnlen(p->ssid, sizeof(p->ssid));
    size_t n = strnlen(p->password, sizeof(p->password));
    if (!s || s > 32 || n > 64) return false;
    if (!n) return true; /* Explicitly open Wi-Fi. */
    if (n < 8) return false;
    if (n == 64) for (size_t i = 0; i < n; ++i) {
        char c = p->password[i];
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'))) return false;
    }
    return true;
}
static inline bool demo_profiles_valid(const demo_wifi_profiles_t *p) {
    if (p->version != 1 || p->count > DEMO_SAVED_NETWORKS) return false;
    for (unsigned i = 0; i < p->count; ++i) {
        if (!demo_profile_valid(&p->items[i])) return false;
        for (unsigned j = 0; j < i; ++j)
            if (!strcmp(p->items[i].ssid, p->items[j].ssid)) return false;
    }
    return true;
}
/* Most recently confirmed network first. Updating an SSID replaces its password;
 * a seventh distinct network evicts only the oldest user profile. */
static inline void demo_profiles_promote(demo_wifi_profiles_t *p, const demo_wifi_profile_t *item) {
    unsigned at = p->count;
    for (unsigned i = 0; i < p->count; ++i) if (!strcmp(p->items[i].ssid, item->ssid)) { at = i; break; }
    if (at == p->count && p->count < DEMO_SAVED_NETWORKS) ++p->count;
    if (at >= DEMO_SAVED_NETWORKS) at = DEMO_SAVED_NETWORKS - 1;
    for (unsigned i = at; i > 0; --i) p->items[i] = p->items[i - 1];
    p->items[0] = *item;
    p->version = 1;
}
