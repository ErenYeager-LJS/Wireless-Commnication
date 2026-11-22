idf_component_register(SRCS "main.c" "frame_link.c" "wireless_control.c" INCLUDE_DIRS "." REQUIRES common esp_video esp_h264 esp_driver_uart esp_hw_support esp_hosted esp_http_client esp-tls mbedtls)
