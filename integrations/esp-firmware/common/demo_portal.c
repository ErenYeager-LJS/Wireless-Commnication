/* AP-only provisioning. Never expose Wi-Fi passwords or permit WAN-side writes. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_random.h"
#include "esp_log.h"
#include "cJSON.h"
#include "lwip/sockets.h"
#include "lwip/inet.h"
#include "demo_network.h"

static char token[33];
extern const unsigned char page_start[] asm("_binary_provision_html_start");
extern const unsigned char page_end[] asm("_binary_provision_html_end");

static bool socket_ipv4(int fd,bool local,uint32_t *address){
    struct sockaddr_storage endpoint={0};socklen_t len=sizeof(endpoint);
    int result=local?getsockname(fd,(struct sockaddr*)&endpoint,&len):getpeername(fd,(struct sockaddr*)&endpoint,&len);
    if(result<0)return false;
    if(endpoint.ss_family==AF_INET){*address=((struct sockaddr_in*)&endpoint)->sin_addr.s_addr;return true;}
#if CONFIG_LWIP_IPV6
    /* IDF's HTTP server uses a dual-stack IPv6 listener by default. */
    if(endpoint.ss_family==AF_INET6){
        const uint8_t *bytes=(const uint8_t*)&((struct sockaddr_in6*)&endpoint)->sin6_addr;
        static const uint8_t mapped[12]={0,0,0,0,0,0,0,0,0,0,0xff,0xff};
        if(!memcmp(bytes,mapped,sizeof(mapped))){memcpy(address,bytes+12,4);return true;}
    }
#endif
    return false;
}
static bool ap_request(httpd_req_t *r){
    uint32_t local=0,peer=0;
    int fd=httpd_req_to_sockfd(r);
    demo_setup_status_t s=demo_network_setup_status();
    return socket_ipv4(fd,true,&local) && socket_ipv4(fd,false,&peer) && local==inet_addr(s.ip) &&
           (peer&htonl(0xffffff00UL))==(local&htonl(0xffffff00UL));
}
static esp_err_t json_reply(httpd_req_t *r,cJSON *root){
    char *json=cJSON_PrintUnformatted(root);cJSON_Delete(root);
    if(!json)return httpd_resp_send_err(r,HTTPD_500_INTERNAL_SERVER_ERROR,"out of memory");
    httpd_resp_set_type(r,"application/json; charset=utf-8");
    httpd_resp_set_hdr(r,"Cache-Control","no-store");
    httpd_resp_set_hdr(r,"X-Content-Type-Options","nosniff");
    esp_err_t e=httpd_resp_sendstr(r,json);free(json);return e;
}
static esp_err_t setup_page(httpd_req_t *r){
    if(!ap_request(r))return httpd_resp_send_err(r,HTTPD_403_FORBIDDEN,"Connect to this device's setup hotspot");
    demo_network_setup_touch();
    /* Captive probes arrive with an unrelated Host. Move to the canonical IP
     * so subsequent same-origin JSON writes pass the origin check. */
    demo_setup_status_t s=demo_network_setup_status();char host[96]={0},with_port[24];
    snprintf(with_port,sizeof(with_port),"%s:80",s.ip);
    if(httpd_req_get_hdr_value_str(r,"Host",host,sizeof(host))!=ESP_OK ||
       (strcmp(host,s.ip)&&strcmp(host,with_port)) || strcmp(r->uri,"/")){
        char location[40];snprintf(location,sizeof(location),"http://%s/",s.ip);
        httpd_resp_set_status(r,"302 Found");httpd_resp_set_hdr(r,"Location",location);
        httpd_resp_set_hdr(r,"Cache-Control","no-store");return httpd_resp_send(r,NULL,0);
    }
    httpd_resp_set_type(r,"text/html; charset=utf-8");
    httpd_resp_set_hdr(r,"Cache-Control","no-store");
    httpd_resp_set_hdr(r,"X-Frame-Options","DENY");
    return httpd_resp_send(r,(const char*)page_start,page_end-page_start-1);
}
static esp_err_t setup_status(httpd_req_t *r){
    if(!ap_request(r))return httpd_resp_send_err(r,HTTPD_403_FORBIDDEN,"AP clients only");
    demo_network_setup_touch();
    demo_setup_status_t s=demo_network_setup_status();demo_network_state_t net=demo_network_state();
    cJSON *root=cJSON_CreateObject(),*list=cJSON_AddArrayToObject(root,"saved");
    cJSON_AddBoolToObject(root,"active",s.active);cJSON_AddBoolToObject(root,"testing",s.testing);
    cJSON_AddBoolToObject(root,"online",net.online);cJSON_AddNumberToObject(root,"remaining_s",s.remaining_s);
    cJSON_AddStringToObject(root,"hotspot",s.hotspot);cJSON_AddStringToObject(root,"ip",s.ip);
    cJSON_AddStringToObject(root,"ssid",net.online?net.ssid:"");cJSON_AddStringToObject(root,"message",s.message);
    cJSON_AddStringToObject(root,"token",token);
    for(unsigned i=0;i<s.saved_count;i++)cJSON_AddItemToArray(list,cJSON_CreateString(s.saved_ssids[i]));
    return json_reply(r,root);
}
static esp_err_t setup_config(httpd_req_t *r){
    if(!ap_request(r))return httpd_resp_send_err(r,HTTPD_403_FORBIDDEN,"AP clients only");
    char origin[96]={0},expected[48],type[64]={0};demo_setup_status_t s=demo_network_setup_status();
    snprintf(expected,sizeof(expected),"http://%s",s.ip);
    if(httpd_req_get_hdr_value_len(r,"Origin")){
        if(httpd_req_get_hdr_value_str(r,"Origin",origin,sizeof(origin))!=ESP_OK || strcmp(origin,expected))
            return httpd_resp_send_err(r,HTTPD_403_FORBIDDEN,"invalid origin; open the device IP directly");
    }
    if(httpd_req_get_hdr_value_str(r,"Content-Type",type,sizeof(type))!=ESP_OK || strncmp(type,"application/json",16))
        return httpd_resp_send_err(r,HTTPD_400_BAD_REQUEST,"JSON required");
    if(r->content_len<2 || r->content_len>512)return httpd_resp_send_err(r,HTTPD_400_BAD_REQUEST,"invalid length");
    char body[513];size_t received=0;
    while(received<r->content_len){
        int n=httpd_req_recv(r,body+received,r->content_len-received);
        if(n<=0)return httpd_resp_send_err(r,HTTPD_408_REQ_TIMEOUT,"request timed out");
        received+=n;
    }
    body[received]=0;
    cJSON *root=cJSON_ParseWithLength(body,received+1);
    cJSON *ssid=cJSON_GetObjectItemCaseSensitive(root,"ssid"),*password=cJSON_GetObjectItemCaseSensitive(root,"password"),*nonce=cJSON_GetObjectItemCaseSensitive(root,"token");
    bool valid=cJSON_IsString(ssid)&&cJSON_IsString(password)&&cJSON_IsString(nonce)&&!strcmp(nonce->valuestring,token);
    demo_wifi_profile_t profile={0};
    if(valid){
        /* Do not truncate byte-length-limited Chinese SSIDs or long passwords. */
        valid=strlen(ssid->valuestring)<=32 && strlen(password->valuestring)<=64;
        if(valid){strlcpy(profile.ssid,ssid->valuestring,sizeof(profile.ssid));strlcpy(profile.password,password->valuestring,sizeof(profile.password));valid=demo_profile_valid(&profile);}
    }
    cJSON_Delete(root);memset(body,0,sizeof(body));
    if(!valid){memset(&profile,0,sizeof(profile));return httpd_resp_send_err(r,HTTPD_400_BAD_REQUEST,"invalid SSID, password or setup token");}
    bool accepted=demo_network_submit_profile(&profile);memset(&profile,0,sizeof(profile));
    if(!accepted){httpd_resp_set_status(r,"409 Conflict");return httpd_resp_sendstr(r,"setup closed, busy, or reserved relay SSID");}
    cJSON *reply=cJSON_CreateObject();cJSON_AddBoolToObject(reply,"accepted",true);
    return json_reply(r,reply);
}
void demo_network_register_portal(httpd_handle_t server){
    for(unsigned i=0;i<4;i++)snprintf(token+i*8,9,"%08lx",(unsigned long)esp_random());
    const char *pages[]={"/","/generate_204","/hotspot-detect.html","/connecttest.txt","/ncsi.txt"};
    for(unsigned i=0;i<sizeof(pages)/sizeof(pages[0]);i++){
        httpd_uri_t uri={.uri=pages[i],.method=HTTP_GET,.handler=setup_page};ESP_ERROR_CHECK(httpd_register_uri_handler(server,&uri));
    }
    httpd_uri_t status={.uri="/wifi/status",.method=HTTP_GET,.handler=setup_status};ESP_ERROR_CHECK(httpd_register_uri_handler(server,&status));
    httpd_uri_t config={.uri="/wifi/config",.method=HTTP_POST,.handler=setup_config};ESP_ERROR_CHECK(httpd_register_uri_handler(server,&config));
}

/* Small captive DNS responder. Bound to the AP IP, not the upstream interface.
 * One IN question, no compressed-name traversal or unbounded allocations. */
static void dns_task(void *unused){
    demo_setup_status_t s=demo_network_setup_status();
    int fd=socket(AF_INET,SOCK_DGRAM,IPPROTO_UDP);
    struct sockaddr_in local={.sin_family=AF_INET,.sin_port=htons(53),.sin_addr.s_addr=inet_addr(s.ip)};
    if(fd<0 || bind(fd,(struct sockaddr*)&local,sizeof(local))<0){if(fd>=0)close(fd);ESP_LOGW("SETUP","Captive DNS unavailable; use the device IP");vTaskDelete(NULL);return;}
    uint8_t b[512];
    for(;;){
        struct sockaddr_in peer;socklen_t size=sizeof(peer);int n=recvfrom(fd,b,sizeof(b)-16,0,(struct sockaddr*)&peer,&size);
        if(n<17 || !demo_network_setup_status().active || b[2]&0x80 || b[4]!=0 || b[5]!=1)continue;
        if((peer.sin_addr.s_addr&htonl(0xffffff00UL))!=(local.sin_addr.s_addr&htonl(0xffffff00UL)))continue;
        unsigned p=12;
        while(p<(unsigned)n && b[p] && b[p]<=63){unsigned length=b[p];p+=length+1;}
        if(p+5>(unsigned)n || b[p]!=0)continue;
        ++p;unsigned qtype=(b[p]<<8)|b[p+1],qclass=(b[p+2]<<8)|b[p+3];p+=4;
        if(qclass!=1)continue;
        b[2]=0x81;b[3]=0x80;b[6]=0;b[7]=qtype==1?1:0;memset(b+8,0,4);
        if(qtype==1){const uint8_t answer[]={0xc0,0x0c,0,1,0,1,0,0,0,0,0,4};memcpy(b+p,answer,sizeof(answer));p+=sizeof(answer);memcpy(b+p,&local.sin_addr.s_addr,4);p+=4;}
        sendto(fd,b,p,0,(struct sockaddr*)&peer,sizeof(peer));
    }
}
void demo_portal_dns_start(void){xTaskCreate(dns_task,"setup-dns",4096,NULL,2,NULL);}
