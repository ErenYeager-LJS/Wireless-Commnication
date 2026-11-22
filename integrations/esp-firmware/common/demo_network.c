/* Shared P4/C6 and ESP32 networking. User Wi-Fi profiles live in NVS. */
#include <stdio.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/event_groups.h"
#include "freertos/semphr.h"
#include "esp_event.h"
#include "esp_wifi.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "nvs_flash.h"
#include "nvs.h"
#include "lwip/inet.h"
#include "secrets.h"
#include "demo_network.h"
#include "link_policy.h"

static const char *TAG="DEMO_NET";
static esp_netif_t *sta_if, *ap_if;
static EventGroupHandle_t events;
static SemaphoreHandle_t lock;
static demo_network_state_t state;
static volatile int force_mode;
static unsigned failures;
static uint32_t last_success;
static bool is_repeater;
#define DIRECT_MAX (DEMO_SAVED_NETWORKS + 2)
#define RELAY_INDEX DIRECT_MAX
#define CANDIDATE_INDEX (DIRECT_MAX + 1)
#define NETWORK_COUNT (DIRECT_MAX + 2)
static wifi_ap_record_t cached[NETWORK_COUNT];
static bool known[NETWORK_COUNT];
static demo_wifi_profile_t networks[NETWORK_COUNT];
static unsigned direct_count;
static demo_wifi_profiles_t saved = {.version = 1};
static demo_wifi_profile_t pending;
static bool pending_ready, pending_testing, setup_active = true, ap_enabled = true;
static uint32_t boot_at;
static bool setup_touched;
static uint32_t setup_touch_at;
static char setup_ssid[33], setup_message[128] = "等待手机添加网络";
static const char *setup_ip;
static uint32_t now_ms(void){return (uint32_t)(esp_timer_get_time()/1000);}
static const char *name(int i){return networks[i].ssid;}
static void rebuild_profiles(void){
    direct_count = 0;
    for(unsigned i=0;i<saved.count;i++) networks[direct_count++] = saved.items[i];
    const char *defaults[] = {DEMO_PRIMARY_SSID, DEMO_FALLBACK_SSID};
    for(unsigned k=0;k<2;k++){
        bool duplicate=false;
        for(unsigned j=0;j<direct_count;j++)if(!strcmp(name(j),defaults[k]))duplicate=true;
        if(!duplicate){
            strlcpy(networks[direct_count].ssid,defaults[k],sizeof(networks[0].ssid));
            strlcpy(networks[direct_count++].password,DEMO_MAIN_PASSWORD,sizeof(networks[0].password));
        }
    }
    strlcpy(networks[RELAY_INDEX].ssid,DEMO_RELAY_SSID,sizeof(networks[0].ssid));
    strlcpy(networks[RELAY_INDEX].password,DEMO_RELAY_PASSWORD,sizeof(networks[0].password));
    memset(known,0,sizeof(known));
}
static void load_profiles(void){
    nvs_handle_t h;size_t size=sizeof(saved);demo_wifi_profiles_t loaded={0};
    if(nvs_open("demo_wifi",NVS_READONLY,&h)==ESP_OK){
        if(nvs_get_blob(h,"profiles",&loaded,&size)==ESP_OK && size==sizeof(loaded) && demo_profiles_valid(&loaded)){
            bool reserved=false;
            for(unsigned i=0;i<loaded.count;i++)if(!strcmp(loaded.items[i].ssid,DEMO_RELAY_SSID))reserved=true;
            if(!reserved)saved=loaded;
        }
        nvs_close(h);
    }
    rebuild_profiles();
    ESP_LOGI(TAG,"Loaded %u user Wi-Fi profiles",(unsigned)saved.count);
}
static bool save_profile(const demo_wifi_profile_t *p){
    demo_wifi_profiles_t next=saved;demo_profiles_promote(&next,p);nvs_handle_t h;
    esp_err_t e=nvs_open("demo_wifi",NVS_READWRITE,&h);
    if(e!=ESP_OK)return false;
    e=nvs_set_blob(h,"profiles",&next,sizeof(next));if(e==ESP_OK)e=nvs_commit(h);nvs_close(h);
    if(e!=ESP_OK){ESP_LOGE(TAG,"Profile save failed: %s",esp_err_to_name(e));return false;}
    xSemaphoreTake(lock,portMAX_DELAY);saved=next;xSemaphoreGive(lock);
    rebuild_profiles();return true;
}
static void update_setup(void){
    demo_network_state_t s=demo_network_state();
    xSemaphoreTake(lock,portMAX_DELAY);
    bool active=now_ms()-boot_at<DEMO_SETUP_WINDOW_MS || !s.online || pending_ready || pending_testing;
    setup_active=active;xSemaphoreGive(lock);
    if(!is_repeater && active!=ap_enabled){
        esp_err_t e=esp_wifi_set_mode(active?WIFI_MODE_APSTA:WIFI_MODE_STA);
        if(e==ESP_OK){ap_enabled=active;ESP_LOGI(TAG,"Camera setup AP %s",active?"opened":"closed");}
    }
}
static int next_target(int current){
    if(!is_repeater && force_mode==2)return RELAY_INDEX;
    if(current>=0 && current+1<(int)direct_count)return current+1;
    if(!is_repeater && force_mode==0 && current!=RELAY_INDEX)return RELAY_INDEX;
    return 0;
}
static void event(void *arg,esp_event_base_t base,int32_t id,void *data){
    if(base==IP_EVENT && id==IP_EVENT_STA_GOT_IP){
        ip_event_got_ip_t *e=data;ESP_LOGI(TAG,"IP=" IPSTR,IP2STR(&e->ip_info.ip));
        xEventGroupSetBits(events,1);
        if(is_repeater){
#if CONFIG_LWIP_IPV4_NAPT
            esp_err_t err=esp_netif_napt_enable(ap_if);
            ESP_LOGI(TAG,"NAT enabled: %s",esp_err_to_name(err));
#endif
        }
    } else if(base==WIFI_EVENT && id==WIFI_EVENT_STA_DISCONNECTED){
        xEventGroupClearBits(events,1);
        xSemaphoreTake(lock,portMAX_DELAY);state.online=false;xSemaphoreGive(lock);
        wifi_event_sta_disconnected_t *e=data;ESP_LOGW(TAG,"Wi-Fi disconnected reason=%u",e->reason);
    } else if(base==WIFI_EVENT && id==WIFI_EVENT_AP_STACONNECTED){
        wifi_event_ap_staconnected_t *e=data;ESP_LOGI(TAG,"Relay client joined: %02x:%02x:%02x:%02x:%02x:%02x",e->mac[0],e->mac[1],e->mac[2],e->mac[3],e->mac[4],e->mac[5]);
    } else if(base==WIFI_EVENT && id==WIFI_EVENT_SCAN_DONE){
        xEventGroupSetBits(events,2);
    }
}
static int scan(uint8_t channel){
    wifi_scan_config_t cfg={.channel=channel,.show_hidden=true,.scan_type=WIFI_SCAN_TYPE_ACTIVE,
                          .scan_time.active={.min=30,.max=70}};
    xSemaphoreTake(lock,portMAX_DELAY);state.scanning=true;xSemaphoreGive(lock);
    xEventGroupClearBits(events,2);
    esp_err_t e=esp_wifi_scan_start(&cfg,false);
    if(e==ESP_OK && !(xEventGroupWaitBits(events,2,pdTRUE,pdFALSE,pdMS_TO_TICKS(3500))&2)){
        esp_wifi_scan_stop();e=ESP_ERR_TIMEOUT;
    }
    xSemaphoreTake(lock,portMAX_DELAY);state.scanning=false;xSemaphoreGive(lock);
    if(e!=ESP_OK){ESP_LOGW(TAG,"Scan: %s",esp_err_to_name(e));return -1;}
    wifi_ap_record_t records[32];uint16_t count=32;
    ESP_ERROR_CHECK(esp_wifi_scan_get_ap_records(&count,records));
    memset(known,0,sizeof(known));
    for(int k=0;k<count;k++)for(int i=0;i<NETWORK_COUNT;i++){
        if(networks[i].ssid[0] && !strcmp((char*)records[k].ssid,name(i)) && (!known[i]||records[k].rssi>cached[i].rssi)){
            cached[i]=records[k];known[i]=true;
        }
    }
    for(unsigned i=0;i<direct_count;i++)if(known[i])return i;
    return -1;
}
static bool connect_to(int i){
    xSemaphoreTake(lock,portMAX_DELAY);state.online=false;state.generation++;failures=0;last_success=now_ms();xSemaphoreGive(lock);
    esp_wifi_disconnect();xEventGroupClearBits(events,1);
    wifi_config_t cfg={0};
    /* IDF permits all 32 SSID bytes and all 64 PSK bytes without a terminator. */
    memcpy(cfg.sta.ssid,name(i),strlen(name(i)));
    memcpy(cfg.sta.password,networks[i].password,strlen(networks[i].password));
    cfg.sta.threshold.authmode=networks[i].password[0]?WIFI_AUTH_WPA2_PSK:WIFI_AUTH_OPEN;
    if(known[i]){cfg.sta.bssid_set=true;memcpy(cfg.sta.bssid,cached[i].bssid,6);cfg.sta.channel=cached[i].primary;}
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA,&cfg));
    ESP_LOGI(TAG,"CONNECT %s route=%s",name(i),i==RELAY_INDEX?"relay":"direct");
    esp_err_t err=esp_wifi_connect();
    if(err!=ESP_OK){ESP_LOGW(TAG,"connect error %s",esp_err_to_name(err));return false;}
    bool ok=(xEventGroupWaitBits(events,1,pdFALSE,pdFALSE,pdMS_TO_TICKS(i==CANDIDATE_INDEX?12000:6500))&1)!=0;
    if(ok){
        wifi_ap_record_t ap;if(esp_wifi_sta_get_ap_info(&ap)==ESP_OK){cached[i]=ap;known[i]=true;}
        xSemaphoreTake(lock,portMAX_DELAY);state.online=true;state.relay=i==RELAY_INDEX;state.rssi=cached[i].rssi;strlcpy(state.ssid,name(i),sizeof(state.ssid));xSemaphoreGive(lock);
        esp_err_t ps_set=esp_wifi_set_ps(WIFI_PS_NONE);
        wifi_ps_type_t ps_mode=WIFI_PS_MIN_MODEM;
        esp_err_t ps_read=esp_wifi_get_ps(&ps_mode);
        ESP_LOGI(TAG,"Power save set=%s read=%s mode=%d",esp_err_to_name(ps_set),esp_err_to_name(ps_read),ps_mode);
        ESP_LOGI(TAG,"ONLINE %s RSSI=%d",name(i),cached[i].rssi);
    }else{known[i]=false;esp_wifi_disconnect();ESP_LOGW(TAG,"Connect timeout: %s",name(i));}
    return ok;
}
static void manager(void *arg){
    /* Leave the radio on the setup channel for 30 seconds before auto-connect.
     * An explicit phone submission can start its connection test immediately. */
    int best=-1,target=0,current=-1;unsigned probes=0,attempts=0;
    uint32_t connected_at=0,last_scan=now_ms(),weak_at=0,last_rssi=0;unsigned good_scans=0;
    for(;;){
        update_setup();
        xSemaphoreTake(lock,portMAX_DELAY);
        bool submitted=pending_ready;
        if(submitted){networks[CANDIDATE_INDEX]=pending;pending_ready=false;pending_testing=true;strlcpy(setup_message,"正在连接；热点换信道时手机可能短暂断开",sizeof(setup_message));}
        xSemaphoreGive(lock);
        if(submitted){
            known[CANDIDATE_INDEX]=false;
            if(connect_to(CANDIDATE_INDEX)){
                wifi_ap_record_t connected=cached[CANDIDATE_INDEX];
                bool stored=save_profile(&networks[CANDIDATE_INDEX]);
                current=stored?0:CANDIDATE_INDEX;
                cached[current]=connected;known[current]=true;
                connected_at=now_ms();last_scan=connected_at;weak_at=0;good_scans=0;attempts=0;
                xSemaphoreTake(lock,portMAX_DELAY);
                strlcpy(setup_message,stored?"已连接并保存，断电后仍可自动连接":"已连接，但保存失败，请重新提交",sizeof(setup_message));
                pending_testing=false;xSemaphoreGive(lock);
            }else{
                xSemaphoreTake(lock,portMAX_DELAY);pending_testing=false;
                strlcpy(setup_message,"连接失败，未保存。请核对密码和 2.4 GHz 设置",sizeof(setup_message));xSemaphoreGive(lock);
                current=-1;target=0;attempts=0;
            }
            continue;
        }
        if(current<0 && now_ms()-boot_at<DEMO_SETUP_WINDOW_MS){vTaskDelay(pdMS_TO_TICKS(100));continue;}
        if(current<0){
            /* Give a connected phone time to fill the form without repeated
             * scans/channel changes. Without a phone, retry saved Wi-Fi. */
            xSemaphoreTake(lock,portMAX_DELAY);
            bool editing=setup_touched && now_ms()-setup_touch_at<15000;
            xSemaphoreGive(lock);
            if(editing){vTaskDelay(pdMS_TO_TICKS(100));continue;}
            if(!is_repeater && force_mode==2)target=RELAY_INDEX;
            if(connect_to(target)){current=target;connected_at=now_ms();last_scan=connected_at;weak_at=0;good_scans=0;attempts=0;}
            else{
                target=next_target(target);
                if(++attempts>=direct_count+(!is_repeater && force_mode==0?1:0)){
                    attempts=0;
                    for(unsigned j=0;j<50;j++){
                        update_setup();
                        xSemaphoreTake(lock,portMAX_DELAY);bool queued=pending_ready;xSemaphoreGive(lock);
                        if(queued)break;
                        vTaskDelay(pdMS_TO_TICKS(100));
                    }
                    /* No cached BSSID is mandatory: a relocated hotspot can
                     * have a new MAC/channel even when its SSID is unchanged. */
                    memset(known,0,sizeof(known));
                }
                vTaskDelay(pdMS_TO_TICKS(300));
            }
            continue;
        }
        uint32_t t=now_ms();demo_network_state_t s=demo_network_state();
        xSemaphoreTake(lock,portMAX_DELAY);unsigned bad=failures;uint32_t success_at=last_success;xSemaphoreGive(lock);
        int next=-1;
        if(!(xEventGroupGetBits(events)&1)){
            if(is_repeater || force_mode==1)next=next_target(current);
            else if(force_mode==2)next=RELAY_INDEX;
            else next=current==RELAY_INDEX?0:RELAY_INDEX;
        }else{
            if(t-last_rssi>=1000){
                last_rssi=t;wifi_ap_record_t ap;
                if(esp_wifi_sta_get_ap_info(&ap)==ESP_OK){xSemaphoreTake(lock,portMAX_DELAY);state.rssi=ap.rssi;xSemaphoreGive(lock);s.rssi=ap.rssi;}
            }
            if(!is_repeater){
                if(force_mode==2 && current!=RELAY_INDEX)next=RELAY_INDEX;
                else if(force_mode==1 && current==RELAY_INDEX)next=0;
                else if(demo_transport_stalled(current==RELAY_INDEX,bad,t-success_at,t-connected_at))
                    next=force_mode==1?next_target(current):force_mode==2?RELAY_INDEX:current==RELAY_INDEX?0:RELAY_INDEX;
                else if(force_mode==0 && current!=RELAY_INDEX){
                    if(s.rssi< -75){if(!weak_at)weak_at=t;if(t-weak_at>=1000 && t-connected_at>=5000)next=RELAY_INDEX;}else weak_at=0;
                }
            }
            /* A healthy relay never does a periodic all-channel scan. A radio
             * leaving its forwarding channel interrupts both camera links. */
            if(next<0 && t-last_scan>=10000 && ((current>0 && current<(int)direct_count) || (!is_repeater&&current==RELAY_INDEX&&force_mode==0))){
                last_scan=t;
                uint8_t channel=cached[current].primary;
                if(current>0 && current<(int)direct_count && is_repeater){
                    wifi_sta_list_t clients={0};
                    if(esp_wifi_ap_get_sta_list(&clients)==ESP_OK && clients.num){
                        vTaskDelay(pdMS_TO_TICKS(50));continue;
                    }
                }
                /* Rare off-channel recovery only after uploads have already
                 * stopped; it must not create stalls on a working relay. */
                if(!is_repeater && t-success_at>=3000 && ++probes%6==0)channel=0;
                best=scan(channel);
                if(current<(int)direct_count && best>=0 && best<current && cached[best].rssi> -65){if(++good_scans>=2 && t-connected_at>=15000)next=best;}
                else if(current==RELAY_INDEX && best>=0 && cached[best].rssi> -65){if(++good_scans>=2 && t-connected_at>=15000)next=best;}
                else good_scans=0;
            }
        }
        if(next>=0){ESP_LOGI(TAG,"SWITCH %s -> %s (failures=%u RSSI=%d)",name(current),name(next),bad,s.rssi);target=next;current=-1;}
        vTaskDelay(pdMS_TO_TICKS(50));
    }
}
void demo_network_start(bool repeater){
    is_repeater=repeater;lock=xSemaphoreCreateMutex();events=xEventGroupCreate();
    esp_err_t e=nvs_flash_init();if(e==ESP_ERR_NVS_NO_FREE_PAGES||e==ESP_ERR_NVS_NEW_VERSION_FOUND){ESP_ERROR_CHECK(nvs_flash_erase());e=nvs_flash_init();}ESP_ERROR_CHECK(e);
    ESP_ERROR_CHECK(esp_netif_init());ESP_ERROR_CHECK(esp_event_loop_create_default());sta_if=esp_netif_create_default_wifi_sta();
    load_profiles();
    ap_if=esp_netif_create_default_wifi_ap();ESP_ERROR_CHECK(esp_netif_dhcps_stop(ap_if));
    esp_netif_ip_info_t ip={0};IP4_ADDR(&ip.ip,192,168,repeater?4:5,1);ip.gw=ip.ip;
    IP4_ADDR(&ip.netmask,255,255,255,0);ESP_ERROR_CHECK(esp_netif_set_ip_info(ap_if,&ip));ESP_ERROR_CHECK(esp_netif_dhcps_start(ap_if));
    setup_ip=repeater?"192.168.4.1":"192.168.5.1";
    wifi_init_config_t cfg=WIFI_INIT_CONFIG_DEFAULT();ESP_ERROR_CHECK(esp_wifi_init(&cfg));ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM));
    uint8_t mac[6];ESP_ERROR_CHECK(esp_wifi_get_mac(WIFI_IF_AP,mac));
    if(repeater)strlcpy(setup_ssid,DEMO_RELAY_SSID,sizeof(setup_ssid));
    else snprintf(setup_ssid,sizeof(setup_ssid),"DEMO_CAM_SETUP_%02X%02X",mac[4],mac[5]);
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT,ESP_EVENT_ANY_ID,event,NULL));ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT,IP_EVENT_STA_GOT_IP,event,NULL));
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_APSTA));
    /* Match the classic ESP32 relay to C6 using HT20 and the supported b/g/n
     * protocol bitmap. This IDF rejects g/n without the b compatibility bit. */
    esp_err_t proto=esp_wifi_set_protocol(WIFI_IF_STA,WIFI_PROTOCOL_11B|WIFI_PROTOCOL_11G|WIFI_PROTOCOL_11N);
    esp_err_t bw=esp_wifi_set_bandwidth(WIFI_IF_STA,WIFI_BW_HT20);
    ESP_LOGI(TAG,"STA b/g/n HT20 protocol=%s bandwidth=%s",esp_err_to_name(proto),esp_err_to_name(bw));
    {
        ESP_ERROR_CHECK(esp_wifi_set_protocol(WIFI_IF_AP,WIFI_PROTOCOL_11B|WIFI_PROTOCOL_11G|WIFI_PROTOCOL_11N));
        ESP_ERROR_CHECK(esp_wifi_set_bandwidth(WIFI_IF_AP,WIFI_BW_HT20));
    }
    wifi_config_t ap={0};strlcpy((char*)ap.ap.ssid,setup_ssid,sizeof(ap.ap.ssid));
    strlcpy((char*)ap.ap.password,repeater?DEMO_RELAY_PASSWORD:DEMO_SETUP_PASSWORD,sizeof(ap.ap.password));
    ap.ap.channel=2;ap.ap.max_connection=4;ap.ap.authmode=WIFI_AUTH_WPA2_PSK;
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_AP,&ap));
    ESP_ERROR_CHECK(esp_wifi_start());
    boot_at=now_ms();
    if(repeater){
        /* Validated near-distance setting; maximum RF power reduced throughput
         * in this physical setup. This is a ceiling in units of 0.25 dBm. */
        ESP_ERROR_CHECK(esp_wifi_set_max_tx_power(DEMO_RELAY_TX_POWER));
    }
    ESP_ERROR_CHECK(esp_wifi_set_ps(WIFI_PS_NONE));
    demo_portal_dns_start();
    if(!repeater){
        httpd_config_t http=HTTPD_DEFAULT_CONFIG();http.max_uri_handlers=12;http.stack_size=6144;
        httpd_handle_t server;ESP_ERROR_CHECK(httpd_start(&server,&http));demo_network_register_portal(server);
    }
    ESP_LOGI(TAG,"Phone setup: %s at http://%s/ (30 second startup window)",setup_ssid,setup_ip);
    xTaskCreate(manager,"network",6144,NULL,5,NULL);
}
demo_network_state_t demo_network_state(void){xSemaphoreTake(lock,portMAX_DELAY);demo_network_state_t s=state;xSemaphoreGive(lock);return s;}
void demo_network_upload_result(bool ok,unsigned generation){xSemaphoreTake(lock,portMAX_DELAY);if(generation==state.generation){if(ok){failures=0;last_success=now_ms();}else if(failures<255)failures++;}xSemaphoreGive(lock);}
void demo_network_upload_idle(unsigned generation){xSemaphoreTake(lock,portMAX_DELAY);if(generation==state.generation){failures=0;last_success=now_ms();}xSemaphoreGive(lock);}
void demo_network_force_route(int mode){if(mode>=0&&mode<=2){force_mode=mode;ESP_LOGI(TAG,"Route mode=%d",mode);}}
int demo_network_force_mode(void){return force_mode;}
esp_netif_t *demo_network_sta(void){return sta_if;}
const char *demo_relay_ssid(void){return DEMO_RELAY_SSID;}
demo_setup_status_t demo_network_setup_status(void){
    demo_setup_status_t result={0};xSemaphoreTake(lock,portMAX_DELAY);
    result.active=setup_active;result.testing=pending_ready||pending_testing;
    uint32_t elapsed=now_ms()-boot_at;
    result.remaining_s=elapsed<DEMO_SETUP_WINDOW_MS?(DEMO_SETUP_WINDOW_MS-elapsed+999)/1000:0;
    result.saved_count=saved.count;
    for(unsigned i=0;i<saved.count;i++)strlcpy(result.saved_ssids[i],saved.items[i].ssid,sizeof(result.saved_ssids[i]));
    strlcpy(result.hotspot,setup_ssid,sizeof(result.hotspot));strlcpy(result.ip,setup_ip,sizeof(result.ip));
    strlcpy(result.message,setup_message,sizeof(result.message));xSemaphoreGive(lock);return result;
}
bool demo_network_submit_profile(const demo_wifi_profile_t *profile){
    if(!demo_profile_valid(profile) || !strcmp(profile->ssid,DEMO_RELAY_SSID))return false;
    xSemaphoreTake(lock,portMAX_DELAY);
    bool allowed=setup_active && !pending_ready && !pending_testing;
    if(allowed){pending=*profile;pending_ready=true;strlcpy(setup_message,"已收到，正在准备连接",sizeof(setup_message));}
    xSemaphoreGive(lock);return allowed;
}
void demo_network_setup_touch(void){
    xSemaphoreTake(lock,portMAX_DELAY);setup_touched=true;setup_touch_at=now_ms();xSemaphoreGive(lock);
}
