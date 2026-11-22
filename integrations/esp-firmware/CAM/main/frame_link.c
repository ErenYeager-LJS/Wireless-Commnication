/* H.264 access units on bounded TCP. Reconnect only on IDR. */
#include <stdio.h>
#include <stdatomic.h>
#include <string.h>
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/select.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>
#include "esp_random.h"
#include "esp_timer.h"
#include "esp_log.h"
#include "esp_heap_caps.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "demo_network.h"
#include "frame_link.h"
#include "cloud_config.h"
#include "esp_tls.h"
#include "esp_sntp.h"
#include <time.h>
#include <sys/time.h>

static atomic_bool enabled=true;
static atomic_uint counter;
static char boot[17],host[20];
static int stream=-1;
static esp_tls_t *tls;
static bool clock_started;
static bool stream_started;
static unsigned generation;
static uint32_t discovery_at,last_ok;
static uint32_t flight_id[8],flight_at[8],acked;
static unsigned flight_head,flight_count,ack_used;
static unsigned ack_rtt_ms=100,flight_limit=6;
static uint8_t ack_bytes[4];
static size_t sent_bytes;
typedef struct {
    uint8_t *data;
    size_t size;
    uint64_t id;
    unsigned width,height,generation;
    bool idr;
    uint32_t captured_at;
} access_unit_t;
#define PIPELINE_SLOTS 10
static access_unit_t slots[PIPELINE_SLOTS];
static QueueHandle_t free_slots,pending;
static uint32_t ms(void){return (uint32_t)(esp_timer_get_time()/1000);}
static void disconnect_stream(void){
    if(tls){esp_tls_conn_destroy(tls);tls=NULL;}else if(stream>=0)close(stream);
    stream=-1;
    stream_started=false;
    flight_head=flight_count=ack_used=0;
}
static bool ready(int fd,bool writing,uint32_t start,unsigned budget){
    unsigned elapsed=ms()-start;if(elapsed>=budget)return false;
    unsigned left=budget-elapsed;struct timeval tv={.tv_sec=left/1000,.tv_usec=(left%1000)*1000};
    fd_set fds;FD_ZERO(&fds);FD_SET(fd,&fds);
    return select(fd+1,writing?NULL:&fds,writing?&fds:NULL,NULL,&tv)>0;
}
static bool send_bytes(const uint8_t *data,size_t size,uint32_t start){
    while(size){
        if(!ready(stream,true,start,1600)){errno=ETIMEDOUT;return false;}
        int n=esp_tls_conn_write(tls,data,size>8192?8192:size);
        if(n==ESP_TLS_ERR_SSL_WANT_WRITE||n==ESP_TLS_ERR_SSL_WANT_READ){vTaskDelay(1);continue;}
        if(n<0&&(errno==EAGAIN||errno==EINTR))continue;
        if(n<=0)return false;
        data+=n;size-=n;sent_bytes+=n;
    }return true;
}
static bool discover(bool relay){
    (void)relay;
    strlcpy(host,CLOUD_HOST,sizeof(host));return true;
#if 0
    int fd=socket(AF_INET,SOCK_DGRAM,IPPROTO_UDP);if(fd<0)return false;
    int yes=1;setsockopt(fd,SOL_SOCKET,SO_BROADCAST,&yes,sizeof(yes));
    struct timeval tv={.tv_usec=250000};setsockopt(fd,SOL_SOCKET,SO_RCVTIMEO,&tv,sizeof(tv));
    esp_netif_ip_info_t ip;if(esp_netif_get_ip_info(demo_network_sta(),&ip)!=ESP_OK){close(fd);return false;}
    struct sockaddr_in target={.sin_family=AF_INET,.sin_port=htons(8081),.sin_addr.s_addr=relay?ip.gw.addr:(ip.ip.addr|~ip.netmask.addr)};
    const char request[]="ESP_RELAY_DISCOVER_V1";
    sendto(fd,request,sizeof(request)-1,0,(struct sockaddr*)&target,sizeof(target));
    char reply[256];int n=recv(fd,reply,sizeof(reply)-1,0);close(fd);
    if(n<=0)return false;
    reply[n]=0;
    return sscanf(reply,"ESP_RELAY_RECEIVER_V1 http://%19[0-9.]",host)==1;
#endif
}
static void be16(uint8_t *p,unsigned v){p[0]=v>>8;p[1]=v;}
static void be32(uint8_t *p,uint32_t v){for(int i=3;i>=0;i--){p[i]=v;v>>=8;}}
static void be64(uint8_t *p,uint64_t v){for(int i=7;i>=0;i--){p[i]=v;v>>=8;}}
static bool feedback(bool wait){
    while(flight_count){
        if(wait&&esp_tls_get_bytes_avail(tls)<=0&&!ready(stream,false,flight_at[flight_head],2000)){errno=ETIMEDOUT;return false;}
        int n=esp_tls_conn_read(tls,ack_bytes+ack_used,4-ack_used);
        if(n==ESP_TLS_ERR_SSL_WANT_READ||n==ESP_TLS_ERR_SSL_WANT_WRITE){if(wait){vTaskDelay(1);continue;}return true;}
        if(n<0&&(errno==EWOULDBLOCK||errno==EAGAIN))return true;
        if(n<=0)return false;
        ack_used+=n;
        if(ack_used!=4){if(wait)continue;return true;}
        uint32_t id=(uint32_t)ack_bytes[0]<<24|ack_bytes[1]<<16|ack_bytes[2]<<8|ack_bytes[3];
        if(id!=flight_id[flight_head])return false;
        unsigned sample=ms()-flight_at[flight_head];
        ack_rtt_ms=(ack_rtt_ms*7+sample)/8;
        /* Cover WAN propagation without an unbounded queue: 4..8 in flight.
         * Freshness/ACK deadlines still force IDR recovery on a stuck path. */
        flight_limit=(ack_rtt_ms*32+999)/1000+2;
        if(flight_limit<4)flight_limit=4;
        if(flight_limit>8)flight_limit=8;
        flight_head=(flight_head+1)%8;flight_count--;ack_used=0;acked++;
        last_ok=ms();demo_network_upload_result(true,generation);
        wait=false;
    }
    return true;
}
static bool transmit(const access_unit_t *unit){
    const uint8_t *data=unit->data;size_t size=unit->size;
    uint64_t id=unit->id;unsigned width=unit->width,height=unit->height;
    bool idr=unit->idr;uint32_t captured_at=unit->captured_at;
    demo_network_state_t net=demo_network_state();
    if(!net.online||!atomic_load(&enabled)){disconnect_stream();return false;}
    if(unit->generation!=net.generation){disconnect_stream();return false;}
    if(ms()-captured_at>750){if(stream_started)disconnect_stream();return false;}
    if(net.generation!=generation){disconnect_stream();host[0]=0;generation=net.generation;discovery_at=ms()-1000;}
    if(!host[0]&&ms()-discovery_at>=800){
        discovery_at=ms();
        if(!discover(net.relay))demo_network_upload_result(false,net.generation);
    }
    if(!host[0])return false;
    sent_bytes=0;
    if(stream>=0){
        if(!feedback(false))goto fail;
        if(flight_count&&ms()-flight_at[flight_head]>=2000){errno=ETIMEDOUT;goto fail;}
        while(flight_count>=flight_limit)if(!feedback(true))goto fail;
    }
    if(stream<0){
        if(!idr)return false;
        if(!clock_started){
            if(time(NULL)<CLOUD_BUILD_EPOCH){struct timeval tv={.tv_sec=CLOUD_BUILD_EPOCH};settimeofday(&tv,NULL);}
            esp_sntp_setoperatingmode(SNTP_OPMODE_POLL);esp_sntp_setservername(0,"time.windows.com");esp_sntp_init();clock_started=true;
        }
        char target_host[20];strlcpy(target_host,host,sizeof(target_host));
        if(net.relay){esp_netif_ip_info_t ip;if(esp_netif_get_ip_info(demo_network_sta(),&ip)!=ESP_OK)goto fail;inet_ntop(AF_INET,&ip.gw.addr,target_host,sizeof(target_host));}
        tls=esp_tls_init();if(!tls)goto fail;
        esp_tls_cfg_t cfg={.cacert_buf=(const unsigned char*)CLOUD_CA,.cacert_bytes=sizeof(CLOUD_CA),
            .common_name=CLOUD_HOST,.timeout_ms=5000,.non_block=true};
        if(esp_tls_conn_new_sync(target_host,strlen(target_host),net.relay?8082:CLOUD_VIDEO_PORT,&cfg,tls)!=1)goto fail;
        if(esp_tls_get_conn_sockfd(tls,&stream)!=ESP_OK)goto fail;
        int yes=1;setsockopt(stream,IPPROTO_TCP,TCP_NODELAY,&yes,sizeof(yes));
        uint32_t start=ms();
        char upgrade[320];int length=snprintf(upgrade,sizeof(upgrade),
            "POST /h264 HTTP/1.1\r\nHost: %s\r\nContent-Length: 0\r\nConnection: Upgrade\r\nUpgrade: esp-h264\r\nX-Device-Id: %s\r\nAuthorization: Bearer %s\r\n\r\n",host,CLOUD_DEVICE_ID,CLOUD_DEVICE_TOKEN);
        if(!send_bytes((uint8_t*)upgrade,length,start))goto fail;
        char response[300]={0};unsigned used=0;
        while(used<sizeof(response)-1&&!strstr(response,"\r\n\r\n")){
            if(esp_tls_get_bytes_avail(tls)<=0&&!ready(stream,false,start,3000))goto fail;
            int n=esp_tls_conn_read(tls,response+used,1);if(n==ESP_TLS_ERR_SSL_WANT_READ||n==ESP_TLS_ERR_SSL_WANT_WRITE)continue;if(n!=1)goto fail;used++;
        }
        if(strncmp(response,"HTTP/1.1 101 ",13))goto fail;
        ESP_LOGI("H264_LINK","Authenticated cloud TLS route=%s",net.relay?"relay":"direct");
        /* TLS setup may outlive a queued frame. Discard the whole GOP and
         * keep the established channel for the next fresh SPS/PPS + IDR. */
        if(ms()-captured_at>750)return false;
    }
    if(!stream_started&&!idr)return false;
    if(ms()-captured_at>750){if(stream_started)disconnect_stream();return false;}
    uint8_t header[80]={0};memcpy(header,"EHV1",4);be32(header+4,size);memcpy(header+8,boot,16);
    be64(header+24,id);be32(header+32,captured_at);be16(header+36,width);be16(header+38,height);
    be16(header+40,(uint16_t)net.rssi);header[42]=net.relay;header[43]=idr;
    memcpy(header+44,net.ssid,strnlen(net.ssid,32));
    uint32_t start=ms();
    if(!send_bytes(header,sizeof(header),start)||!send_bytes(data,size,start))goto fail;
    stream_started=true;
    unsigned tail=(flight_head+flight_count)%8;
    flight_id[tail]=(uint32_t)id;flight_at[tail]=start;flight_count++;
    if(!feedback(false))goto fail;
    return true;
fail:
    ESP_LOGW("H264_LINK","Stream reset errno=%d RSSI=%d bytes=%u/%u flight=%u",errno,net.rssi,(unsigned)sent_bytes,(unsigned)size,flight_count);
    disconnect_stream();demo_network_upload_result(false,generation);
    if(ms()-last_ok>3000)host[0]=0;
    return false;
}
static void upload(void *arg){
    access_unit_t *unit;uint64_t previous=0;unsigned count=0,previous_acked=0;
    uint32_t at=ms();uint64_t elapsed_us=0;
    for(;;){
        if(xQueueReceive(pending,&unit,pdMS_TO_TICKS(30))!=pdTRUE){
            if(stream>=0&&!feedback(false))disconnect_stream();
            continue;
        }
        /* Dropping even one reference picture invalidates the GOP. Abort
         * the stream and wait for a complete IDR, never decode broken P's. */
        if(previous&&unit->id!=previous+1)disconnect_stream();
        previous=unit->id;
        int64_t start=esp_timer_get_time();
        count+=transmit(unit);elapsed_us+=esp_timer_get_time()-start;
        xQueueSend(free_slots,&unit,portMAX_DELAY);
        if(ms()-at>=2000){
            ESP_LOGI("H264_LINK","decoded_ack_fps=%.2f service_ms=%.2f queue=%u flight=%u window=%u ack_rtt_ms=%u",
                (acked-previous_acked)*1000.0/(ms()-at),count?elapsed_us/1000.0/count:0,(unsigned)uxQueueMessagesWaiting(pending),flight_count,flight_limit,ack_rtt_ms);
            previous_acked=acked;at=ms();count=0;elapsed_us=0;
        }
    }
}
bool demo_publish_h264(const uint8_t *data,size_t size,unsigned width,unsigned height,bool idr,uint32_t captured_at){
    uint64_t id=atomic_fetch_add(&counter,1)+1;access_unit_t *unit;
    if(size>512*1024||xQueueReceive(free_slots,&unit,0)!=pdTRUE)return false;
    memcpy(unit->data,data,size);unit->size=size;unit->id=id;
    unit->width=width;unit->height=height;unit->idr=idr;unit->captured_at=captured_at;
    unit->generation=demo_network_state().generation;
    if(xQueueSend(pending,&unit,0)==pdTRUE)return true;
    xQueueSend(free_slots,&unit,portMAX_DELAY);return false;
}
bool demo_frame_ready(void){return free_slots&&uxQueueMessagesWaiting(free_slots)>0;}
void frame_link_start(void){
    snprintf(boot,sizeof(boot),"%08lx%08lx",(unsigned long)esp_random(),(unsigned long)esp_random());
    free_slots=xQueueCreate(PIPELINE_SLOTS,sizeof(access_unit_t*));pending=xQueueCreate(PIPELINE_SLOTS,sizeof(access_unit_t*));
    assert(free_slots&&pending);
    for(unsigned i=0;i<PIPELINE_SLOTS;i++){
        slots[i].data=heap_caps_malloc(512*1024,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT);assert(slots[i].data);
        access_unit_t *unit=&slots[i];xQueueSend(free_slots,&unit,portMAX_DELAY);
    }
    xTaskCreatePinnedToCore(upload,"h264-upload",6144,NULL,4,NULL,0);
}
uint64_t demo_frame_count(unsigned camera){return camera==0?atomic_load(&counter):0;}
bool demo_camera_enabled(unsigned camera){return camera==0&&atomic_load(&enabled);}
void demo_camera_set_enabled(unsigned camera,bool value){if(camera==0)atomic_store(&enabled,value);}
