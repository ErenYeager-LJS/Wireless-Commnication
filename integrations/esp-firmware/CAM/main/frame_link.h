#pragma once
#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>
/* A sole camera producer checks capacity before encoding, so queue pressure
 * drops raw pictures rather than breaking the H.264 reference chain. */
bool demo_frame_ready(void);

#define DEMO_FRAME_LIMIT (256 * 1024)
void frame_link_start(void);
bool demo_publish_h264(const uint8_t *data, size_t size, unsigned width,
                       unsigned height, bool idr, uint32_t captured_at);
uint64_t demo_frame_count(unsigned camera);
bool demo_camera_enabled(unsigned camera);
void demo_camera_set_enabled(unsigned camera, bool enabled);
