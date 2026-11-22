/* Discovery and bounded live-video UDP forwarding; NAT retained for other traffic. */
#include <stdio.h>
#include <string.h>
#include <stdatomic.h>
#include <fcntl.h>
#include <errno.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/select.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_http_server.h"
#include "esp_wifi.h"
#include "esp_timer.h"
#include "esp_system.h"
#include "demo_network.h"
#include "cloud_config.h"

static atomic_uint camera_packets,pc_packets,pc_acks,camera_acks,send_errors;
static atomic_uint last_camera_at,last_ack_at;
static atomic_int last_send_errno;
static atomic_uint receiver_address,proxy_to_pc,proxy_to_camera,proxy_connections;
static uint32_t milliseconds(void){return (uint32_t)(esp_timer_get_time()/1000);}
static bool writable(int fd,uint32_t start,unsigned budget){
    unsigned elapsed=milliseconds()-start;if(elapsed>=budget)return false;
    unsigned remaining=budget-elapsed;
    struct timeval timeout={.tv_sec=remaining/1000,.tv_usec=remaining%1000*1000};
    fd_set out;FD_ZERO(&out);FD_SET(fd,&out);
    return select(fd+1,NULL,&out,NULL,&timeout)>0;
}
static bool proxy_write(int fd,const uint8_t *data,unsigned length){
    uint32_t at=milliseconds();
    while(length){
        if(!writable(fd,at,1600))return false;
        int n=send(fd,data,length,0);
        if(n<0&&(errno==EAGAIN||errno==EINTR))continue;
        if(n<=0)return false;
        data+=n;length-=n;
    }return true;
}
/* Terminate the two TCP legs locally. This avoids the NAPT data path while
 * preserving the camera -> PC decoder ACK and bounded stream lifetime. */
static void video_proxy(void *arg){
    int listener=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP),yes=1;
    setsockopt(listener,SOL_SOCKET,SO_REUSEADDR,&yes,sizeof(yes));
    struct sockaddr_in local={.sin_family=AF_INET,.sin_port=htons(8082),.sin_addr.s_addr=INADDR_ANY};
    ESP_ERROR_CHECK(bind(listener,(struct sockaddr*)&local,sizeof(local))==0?ESP_OK:ESP_FAIL);
    listen(listener,2);uint8_t *buffer=malloc(4096);assert(buffer);
    for(;;){
        struct sockaddr_in peer;socklen_t length=sizeof(peer);
        int downstream=accept(listener,(struct sockaddr*)&peer,&length);
        if(downstream<0){vTaskDelay(pdMS_TO_TICKS(50));continue;}
        uint32_t address=inet_addr(CLOUD_HOST);
        if(!address||(ntohl(peer.sin_addr.s_addr)&0xffffff00UL)!=0xc0a80400UL){close(downstream);continue;}
        int upstream=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);
        if(upstream<0){close(downstream);continue;}
        fcntl(upstream,F_SETFL,O_NONBLOCK);fcntl(downstream,F_SETFL,O_NONBLOCK);
        setsockopt(upstream,IPPROTO_TCP,TCP_NODELAY,&yes,sizeof(yes));
        setsockopt(downstream,IPPROTO_TCP,TCP_NODELAY,&yes,sizeof(yes));
        struct sockaddr_in pc={.sin_family=AF_INET,.sin_port=htons(CLOUD_VIDEO_PORT),.sin_addr.s_addr=address};
        int result=connect(upstream,(struct sockaddr*)&pc,sizeof(pc));
        if(result<0&&errno==EINPROGRESS){
            int error=0;socklen_t len=sizeof(error);
            result=writable(upstream,milliseconds(),3000)?getsockopt(upstream,SOL_SOCKET,SO_ERROR,&error,&len):-1;
            if(error)result=-1;
        }
        atomic_fetch_add(&proxy_connections,1);
        uint32_t started=milliseconds(),down_bytes=0,up_bytes=0;
        uint32_t active_at=milliseconds();
        while(result==0&&milliseconds()-active_at<10000){
            fd_set input;FD_ZERO(&input);FD_SET(downstream,&input);FD_SET(upstream,&input);
            struct timeval timeout={.tv_usec=100000};
            int count=select((upstream>downstream?upstream:downstream)+1,&input,NULL,NULL,&timeout);
            if(count<0)break;
            for(unsigned leg=0;leg<2&&count>0;leg++){
                int source=leg?upstream:downstream,destination=leg?downstream:upstream;
                if(!FD_ISSET(source,&input))continue;
                int n=recv(source,buffer,4096,0);
                if(n<0&&(errno==EAGAIN||errno==EINTR))continue;
                if(n<=0||!proxy_write(destination,buffer,n)){result=-1;break;}
                atomic_fetch_add(leg?&proxy_to_camera:&proxy_to_pc,n);active_at=milliseconds();
                if(leg)up_bytes+=n;else down_bytes+=n;
            }
        }
        ESP_LOGI("H264_PROXY","closed ms=%lu camera_bytes=%lu pc_bytes=%lu result=%d errno=%d",
            (unsigned long)(milliseconds()-started),(unsigned long)down_bytes,(unsigned long)up_bytes,result,errno);
        shutdown(upstream,SHUT_RDWR);shutdown(downstream,SHUT_RDWR);
        close(upstream);close(downstream);
    }
}
static esp_err_t bench_up(httpd_req_t *request){
    if(request->content_len>1024*1024)return httpd_resp_send_err(request,HTTPD_400_BAD_REQUEST,"limit 1 MiB");
    char block[1024];unsigned received=0;uint32_t start=milliseconds();
    while(received<request->content_len){
        int n=httpd_req_recv(request,block,sizeof(block));if(n<=0)return ESP_FAIL;received+=n;
    }
    char reply[96];snprintf(reply,sizeof(reply),"{\"bytes\":%u,\"ms\":%lu}",received,(unsigned long)(milliseconds()-start));
    httpd_resp_set_type(request,"application/json");return httpd_resp_sendstr(request,reply);
}
static esp_err_t bench_down(httpd_req_t *request){
    char block[1024];memset(block,0x5a,sizeof(block));httpd_resp_set_type(request,"application/octet-stream");
    for(unsigned i=0;i<512;i++)if(httpd_resp_send_chunk(request,block,sizeof(block))!=ESP_OK)return ESP_FAIL;
    return httpd_resp_send_chunk(request,NULL,0);
}
static void transport_stats(void *arg){
    for(;;){
        vTaskDelay(pdMS_TO_TICKS(2000));
        if(!atomic_load(&camera_packets))continue;
        ESP_LOGI("RELAY_LINK","camera=%u pc=%u ack=%u/%u drops=%u errno=%d age=%lu/%lu heap=%lu",
            atomic_load(&camera_packets),atomic_load(&pc_packets),atomic_load(&pc_acks),atomic_load(&camera_acks),
            atomic_load(&send_errors),atomic_load(&last_send_errno),
            (unsigned long)(milliseconds()-atomic_load(&last_camera_at)),
            (unsigned long)(milliseconds()-atomic_load(&last_ack_at)),(unsigned long)esp_get_free_heap_size());
    }
}

static esp_err_t status(httpd_req_t *r){
    demo_network_state_t s=demo_network_state();char b[900];
    int8_t tx_power=0;wifi_sta_list_t clients={0};uint8_t channel=0;wifi_second_chan_t second;
    esp_wifi_get_max_tx_power(&tx_power);esp_wifi_ap_get_sta_list(&clients);
    esp_wifi_get_channel(&channel,&second);
    snprintf(b,sizeof(b),"{\"online\":%s,\"ssid\":\"%s\",\"rssi\":%d,\"ap\":\"DEMO_RELAY\",\"nat\":true,\"tx_power_dbm\":%.2f,\"clients\":%d,\"client_rssi\":%d,\"channel\":%u,\"uptime_s\":%llu,\"camera_packets\":%u,\"pc_packets\":%u,\"pc_acks\":%u,\"camera_acks\":%u,\"send_errors\":%u,\"camera_packet_age_ms\":%lu,\"pc_ack_age_ms\":%lu,\"free_heap\":%lu}",
             s.online?"true":"false",s.ssid,s.rssi,tx_power/4.0,clients.num,
             clients.num?clients.sta[0].rssi:-127,channel,(unsigned long long)(esp_timer_get_time()/1000000),
             atomic_load(&camera_packets),atomic_load(&pc_packets),atomic_load(&pc_acks),atomic_load(&camera_acks),atomic_load(&send_errors),
             (unsigned long)(milliseconds()-atomic_load(&last_camera_at)),(unsigned long)(milliseconds()-atomic_load(&last_ack_at)),
             (unsigned long)esp_get_free_heap_size());
    size_t used=strlen(b);
    if(used&&b[used-1]=='}')snprintf(b+used-1,sizeof(b)-used+1,
        ",\"video_proxy\":true,\"video_to_pc_bytes\":%u,\"video_to_camera_bytes\":%u,\"video_connections\":%u}",
        atomic_load(&proxy_to_pc),atomic_load(&proxy_to_camera),atomic_load(&proxy_connections));
    httpd_resp_set_type(r,"application/json");return httpd_resp_sendstr(r,b);
}
static esp_err_t radio_tune(httpd_req_t *r){
    char query[80],mode[12],power[12];
    if(httpd_req_get_url_query_str(r,query,sizeof(query))!=ESP_OK)return httpd_resp_send_err(r,HTTPD_400_BAD_REQUEST,"missing radio settings");
    esp_err_t result=ESP_OK;
    if(httpd_query_key_value(query,"mode",mode,sizeof(mode))==ESP_OK){
        unsigned protocol=WIFI_PROTOCOL_11B|WIFI_PROTOCOL_11G;
        if(!strcmp(mode,"bgn"))protocol|=WIFI_PROTOCOL_11N;
        else if(strcmp(mode,"bg"))return httpd_resp_send_err(r,HTTPD_400_BAD_REQUEST,"mode must be bg or bgn");
        result=esp_wifi_set_protocol(WIFI_IF_AP,protocol);
    }
    if(httpd_query_key_value(query,"tx",power,sizeof(power))==ESP_OK){
        int value=atoi(power);
        if(value!=44&&value!=56&&value!=68&&value!=78)return httpd_resp_send_err(r,HTTPD_400_BAD_REQUEST,"unsupported power");
        result=esp_wifi_set_max_tx_power(value);
    }
    ESP_LOGI("RADIO","Tune %s result=%s",query,esp_err_to_name(result));
    return result==ESP_OK?status(r):httpd_resp_send_err(r,HTTPD_500_INTERNAL_SERVER_ERROR,esp_err_to_name(result));
}
#if 0 /* LAN discovery intentionally disabled in the cloud-only build. */
static void discover(void *arg){
    int fd=socket(AF_INET,SOCK_DGRAM,IPPROTO_UDP),yes=1;
    int receive_buffer=48*1024;setsockopt(fd,SOL_SOCKET,SO_RCVBUF,&receive_buffer,sizeof(receive_buffer));setsockopt(fd,SOL_SOCKET,SO_BROADCAST,&yes,sizeof(yes));
    struct sockaddr_in local={.sin_family=AF_INET,.sin_port=htons(8081),.sin_addr.s_addr=INADDR_ANY};
    ESP_ERROR_CHECK(bind(fd,(struct sockaddr*)&local,sizeof(local))==0?ESP_OK:ESP_FAIL);
    struct sockaddr_in camera={0},discovery_camera={0},video_receiver={0};socklen_t len;char data[1100];
    struct sockaddr_in control_camera={0},control_receiver={0};
    uint32_t control_reply_at=0;
    struct timeval timeout={.tv_usec=100000};setsockopt(fd,SOL_SOCKET,SO_RCVTIMEO,&timeout,sizeof(timeout));
    /* A full outbound queue drops this datagram instead of blocking all video
     * and ACKs behind a stale packet. XOR recovery handles isolated losses. */
    struct timeval send_timeout={.tv_usec=20000};setsockopt(fd,SOL_SOCKET,SO_SNDTIMEO,&send_timeout,sizeof(send_timeout));
    for(;;){
        struct sockaddr_in peer;len=sizeof(peer);int n=recvfrom(fd,data,sizeof(data)-1,0,(struct sockaddr*)&peer,&len);if(n<1)continue;data[n]=0;
        bool downstream=(ntohl(peer.sin_addr.s_addr)&0xffffff00UL)==0xc0a80400UL;
        if(n==51&&(!memcmp(data,"ECP1 ",5)||!memcmp(data,"ECA1 ",5))&&downstream){
            control_camera=peer;
            if(milliseconds()-control_reply_at>3000)control_receiver.sin_port=0;
            if(control_receiver.sin_port)
                sendto(fd,data,n,MSG_DONTWAIT,(struct sockaddr*)&control_receiver,sizeof(control_receiver));
            else if(!memcmp(data,"ECP1 ",5)){
                esp_netif_ip_info_t ip;
                if(esp_netif_get_ip_info(demo_network_sta(),&ip)==ESP_OK&&demo_network_state().online){
                    struct sockaddr_in broadcast={.sin_family=AF_INET,.sin_port=htons(8081),.sin_addr.s_addr=ip.ip.addr|~ip.netmask.addr};
                    sendto(fd,data,n,MSG_DONTWAIT,(struct sockaddr*)&broadcast,sizeof(broadcast));
                }
            }
        }else if(n==51&&!memcmp(data,"ECS1 ",5)&&!downstream&&peer.sin_port==htons(8081)&&control_camera.sin_port){
            /* Keep the independent control address valid while video is
             * paused. Video/discovery sockets never overwrite this endpoint. */
            control_receiver=peer;
            control_reply_at=milliseconds();
            sendto(fd,data,n,MSG_DONTWAIT,(struct sockaddr*)&control_camera,sizeof(control_camera));
        }else if(n>=80&&n<=1080&&!memcmp(data,"EJR2",4)){
            if(downstream&&video_receiver.sin_port){
                atomic_fetch_add(&camera_packets,1);atomic_store(&last_camera_at,milliseconds());
                camera=peer;
                if(sendto(fd,data,n,MSG_DONTWAIT,(struct sockaddr*)&video_receiver,sizeof(video_receiver))==n)atomic_fetch_add(&pc_packets,1);
                else {atomic_store(&last_send_errno,errno);atomic_fetch_add(&send_errors,1);}
            }
        }else if(n==29&&!memcmp(data,"EJA2",4)){
            if(camera.sin_port&&peer.sin_addr.s_addr==video_receiver.sin_addr.s_addr&&peer.sin_port==video_receiver.sin_port){
                atomic_fetch_add(&pc_acks,1);atomic_store(&last_ack_at,milliseconds());
                if(sendto(fd,data,n,MSG_DONTWAIT,(struct sockaddr*)&camera,sizeof(camera))==n)atomic_fetch_add(&camera_acks,1);
                else {atomic_store(&last_send_errno,errno);atomic_fetch_add(&send_errors,1);}
            }
        }else if(!strcmp(data,"ESP_RELAY_DISCOVER_V1")){
            /* Only forward downstream clients; never rebroadcast our own request. */
            if(!downstream)continue;
            /* Discovery uses a different camera socket. Never overwrite the
             * video/ACK destination with this short-lived discovery port. */
            discovery_camera=peer;esp_netif_ip_info_t ip;if(esp_netif_get_ip_info(demo_network_sta(),&ip)!=ESP_OK||!demo_network_state().online)continue;
            struct sockaddr_in target={.sin_family=AF_INET,.sin_port=htons(8081),.sin_addr.s_addr=ip.ip.addr|~ip.netmask.addr};
            sendto(fd,data,n,0,(struct sockaddr*)&target,sizeof(target));
        }else if(!strncmp(data,"ESP_RELAY_RECEIVER_V1 http://",sizeof("ESP_RELAY_RECEIVER_V1 http://")-1) && discovery_camera.sin_port){
            /* Replies carry the receiver address on its LAN. Video and ACKs
             * use our fixed UDP socket, bypassing per-stream NAPT mappings. */
            char host[20];unsigned port;
            if(sscanf(data,"ESP_RELAY_RECEIVER_V1 http://%19[0-9.]:%u/",host,&port)==2){
                video_receiver.sin_family=AF_INET;video_receiver.sin_port=htons(8081);
                inet_aton(host,&video_receiver.sin_addr);
                atomic_store(&receiver_address,video_receiver.sin_addr.s_addr);
            }
            sendto(fd,data,n,0,(struct sockaddr*)&discovery_camera,sizeof(discovery_camera));
        }
    }
}
#endif
void app_main(void){
    demo_network_start(true); /* Cloud controls use signed outbound unicast through NAPT. */
    xTaskCreate(video_proxy,"h264-tcp-proxy",6144,NULL,4,NULL);
    xTaskCreate(transport_stats,"relay-stats",3072,NULL,1,NULL);
    httpd_config_t cfg=HTTPD_DEFAULT_CONFIG();httpd_handle_t h;
    cfg.max_uri_handlers=16;cfg.stack_size=6144;
    if(httpd_start(&h,&cfg)==ESP_OK){demo_network_register_portal(h);httpd_uri_t uri={.uri="/status",.method=HTTP_GET,.handler=status};httpd_register_uri_handler(h,&uri);
        httpd_uri_t tune={.uri="/radio",.method=HTTP_POST,.handler=radio_tune};httpd_register_uri_handler(h,&tune);
        httpd_uri_t up={.uri="/bench/up",.method=HTTP_POST,.handler=bench_up};httpd_register_uri_handler(h,&up);
        httpd_uri_t down={.uri="/bench/down",.method=HTTP_GET,.handler=bench_down};httpd_register_uri_handler(h,&down);}
    ESP_LOGI("REPEATER","DEMO_RELAY gateway=192.168.4.1; upstream primary then fallback");
}
