/* Camera-initiated control polls work on both LAN and relay NAT, even with
 * video paused. No serial port or inbound camera HTTP needed. */
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <unistd.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "esp_log.h"
#include "demo_network.h"
#include "frame_link.h"
#include "control_protocol.h"
#include "wireless_control.h"
#include "cloud_config.h"
#include "cloud_sign.h"
#include <arpa/inet.h>

static uint32_t now_ms(void){return (uint32_t)(esp_timer_get_time()/1000);}
static unsigned camera_mask(void){return demo_camera_enabled(0);}
static void control_task(void *arg){
    char boot[17],packet[180],reply[180];
    snprintf(boot,sizeof(boot),"%08lx%08lx",(unsigned long)esp_random(),(unsigned long)esp_random());
    uint32_t sequence=esp_random(),last_reply=now_ms();unsigned generation=0;
    uint32_t issued[8]={0},issued_at[8]={0},last_command_sequence=0;
    bool have_command=false;
    uint64_t applied=0;int fd=-1;bool paired=false;
    struct sockaddr_in target={.sin_family=AF_INET,.sin_port=htons(CLOUD_CONTROL_PORT)};
    for(;;){
        demo_network_state_t net=demo_network_state();
        if(fd>=0&&(!net.online||net.generation!=generation||now_ms()-last_reply>3000)){
            close(fd);fd=-1;paired=false;
            memset(issued_at,0,sizeof(issued_at));
        }
        if(!net.online){vTaskDelay(pdMS_TO_TICKS(100));continue;}
        if(fd<0){
            esp_netif_ip_info_t ip;
            if(esp_netif_get_ip_info(demo_network_sta(),&ip)!=ESP_OK){vTaskDelay(pdMS_TO_TICKS(100));continue;}
            inet_aton(CLOUD_HOST,&target.sin_addr);
            fd=socket(AF_INET,SOCK_DGRAM,IPPROTO_UDP);
            if(fd<0){vTaskDelay(pdMS_TO_TICKS(500));continue;}
            int yes=1;setsockopt(fd,SOL_SOCKET,SO_BROADCAST,&yes,sizeof(yes));
            struct timeval timeout={.tv_usec=600000};setsockopt(fd,SOL_SOCKET,SO_RCVTIMEO,&timeout,sizeof(timeout));
            setsockopt(fd,SOL_SOCKET,SO_SNDTIMEO,&timeout,sizeof(timeout));
            generation=net.generation;last_reply=now_ms();paired=true;
            if(paired&&connect(fd,(struct sockaddr*)&target,sizeof(target))<0){close(fd);fd=-1;continue;}
        }
        uint32_t started=now_ms();sequence++;
        issued[sequence%8]=sequence;issued_at[sequence%8]=started;
        int n=snprintf(packet,sizeof(packet),"ECP1 %s %08lx %016llx %u %u",boot,(unsigned long)sequence,
                       (unsigned long long)applied,demo_network_force_mode(),camera_mask());
        n=cloud_seal(packet,sizeof(packet));
        int sent=paired?send(fd,packet,n,0):sendto(fd,packet,n,0,(struct sockaddr*)&target,sizeof(target));
        if(sent==n){
            struct sockaddr_in peer;socklen_t peer_size=sizeof(peer);
            int received=recvfrom(fd,reply,sizeof(reply),0,(struct sockaddr*)&peer,&peer_size);
            received=cloud_unseal(reply,received)?51:0;
            demo_control_command_t command;
            char echoed[9]={0};uint32_t echoed_sequence=0;
            if(received==51){memcpy(echoed,reply+22,8);echoed_sequence=(uint32_t)strtoul(echoed,NULL,16);}
            unsigned slot=echoed_sequence%8;
            bool recent=demo_control_recent(now_ms(),issued_at[slot],issued[slot],echoed_sequence);
            if(received==51&&recent&&peer.sin_port==htons(CLOUD_CONTROL_PORT)&&demo_control_reply(reply,received,boot,echoed_sequence,&command)){
                last_reply=now_ms();
                if(!paired){
                    target=peer;
                    if(connect(fd,(struct sockaddr*)&target,sizeof(target))==0)paired=true;
                }
                if(command.op&&command.id!=applied&&demo_control_newer(have_command,echoed_sequence,last_command_sequence)){
                    last_command_sequence=echoed_sequence;have_command=true;
                    unsigned mode=demo_network_force_mode();
                    if(command.op==1)mode=command.value;
                    else demo_camera_set_enabled(command.op-2,command.value!=0);
                    applied=command.id;
                    n=snprintf(packet,sizeof(packet),"ECA1 %s %08lx %016llx %u %u",boot,(unsigned long)echoed_sequence,
                               (unsigned long long)applied,mode,camera_mask());
                    n=cloud_seal(packet,sizeof(packet));
                    if(paired)send(fd,packet,n,0);
                    else sendto(fd,packet,n,0,(struct sockaddr*)&target,sizeof(target));
                    ESP_LOGI("CONTROL_WIFI","Accepted command=%016llx op=%u value=%u via Wi-Fi",
                             (unsigned long long)command.id,command.op,command.value);
                    if(command.op==1){
                        /* Put the receipt on air before the manager disconnects
                         * this path. Later polls also carry the applied ID. */
                        vTaskDelay(pdMS_TO_TICKS(200));demo_network_force_route(mode);
                    }
                }
            }
        }
        uint32_t took=now_ms()-started;
        vTaskDelay(pdMS_TO_TICKS(took<500?500-took:10));
    }
}
void wireless_control_start(void){xTaskCreate(control_task,"wireless-control",4096,NULL,2,NULL);}
