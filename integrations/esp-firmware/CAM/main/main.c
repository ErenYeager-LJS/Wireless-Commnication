/* 慧勤智远 ESP32-P4 CB V1.2 + OV5647，使用商家提供的 esp_video 0.5.1。 */
#include <stdio.h>
#include <string.h>
#include <fcntl.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "esp_heap_caps.h"
#include "esp_ldo_regulator.h"
#include "esp_cache.h"
#include "driver/gpio.h"
#include "driver/uart.h"
#include "esp_h264_enc_single_hw.h"
#include "esp_h264_enc_single.h"
#include "esp_h264_alloc.h"
#include "esp_hosted.h"
#include "esp_http_client.h"
#include "esp_video_init.h"
#include "linux/videodev2.h"
#include "demo_network.h"
#include "frame_link.h"
#include "wireless_control.h"

#define WIDTH 320
#define HEIGHT 240
#define MAX_JPEG (256*1024)
static const char *TAG="CAMERA";
static esp_ldo_channel_handle_t mipi_power;

/* Diagnostic only, with video paused: isolate the camera-to-relay TCP leg. */
static void network_benchmark(const char *url){
    if(demo_camera_enabled(0)){ESP_LOGW(TAG,"Pause video before throughput measurement");return;}
    esp_http_client_config_t cfg={.url=url,.timeout_ms=8000,.method=HTTP_METHOD_POST};
    esp_http_client_handle_t client=esp_http_client_init(&cfg);
    if(!client)return;
    const unsigned total=512*1024;unsigned sent=0;char block[1024];memset(block,0x5a,sizeof(block));
    int64_t start=esp_timer_get_time();
    esp_err_t result=esp_http_client_open(client,total);
    if(result==ESP_OK){
        while(sent<total){int n=esp_http_client_write(client,block,sizeof(block));if(n<=0)break;sent+=n;}
        if(sent==total)esp_http_client_fetch_headers(client);
    }
    double seconds=(esp_timer_get_time()-start)/1000000.0;
    ESP_LOGI(TAG,"NETBENCH bytes=%u seconds=%.3f Mbps=%.3f HTTP=%d result=%s",sent,seconds,
        seconds>0?sent*8/seconds/1000000:0,esp_http_client_get_status_code(client),esp_err_to_name(result));
    esp_http_client_cleanup(client);
}

static void control(void *arg){
    ESP_ERROR_CHECK(uart_driver_install(UART_NUM_0,2048,0,0,NULL,0));char line[80];size_t used=0;
    for(;;){uint8_t c;if(uart_read_bytes(UART_NUM_0,&c,1,pdMS_TO_TICKS(100))!=1)continue;
        if(c=='\r'||c=='\n'){
            line[used]=0;
            if(!strcmp(line,"route relay"))demo_network_force_route(2);
            else if(!strcmp(line,"route direct"))demo_network_force_route(1);
            else if(!strcmp(line,"route auto"))demo_network_force_route(0);
            else if(!strcmp(line,"camera mipi on"))demo_camera_set_enabled(0,true);
            else if(!strcmp(line,"camera mipi off"))demo_camera_set_enabled(0,false);
            else if(!strncmp(line,"netbench http://",16))network_benchmark(line+9);
            else if(!strcmp(line,"c6 version")){
                esp_hosted_coprocessor_fwver_t version={0};
                esp_err_t e=esp_hosted_get_coprocessor_fwversion(&version);
                ESP_LOGI(TAG,"C6 firmware=%lu.%lu.%lu result=%s",(unsigned long)version.major1,
                    (unsigned long)version.minor1,(unsigned long)version.patch1,esp_err_to_name(e));
            }
            else if(!strncmp(line,"c6 update http://",17)){
                if(demo_camera_enabled(0))ESP_LOGW(TAG,"Pause video before co-processor maintenance");
                else{
                    esp_err_t e=esp_hosted_slave_ota(line+10);
                    ESP_LOGI(TAG,"C6 update result=%s",esp_err_to_name(e));
                    if(e==ESP_OK)esp_restart();
                }
            }
            else if(!strcmp(line,"status")){
                demo_network_state_t n=demo_network_state();
                ESP_LOGI(TAG,"STATUS online=%d route=%s ssid=%s RSSI=%d frames=%llu",n.online,n.relay?"relay":"direct",n.ssid,n.rssi,(unsigned long long)demo_frame_count(0));
            }
            used=0;
        }
        else if(used<sizeof(line)-1)line[used++]=c;
    }
}
static void camera(void *arg){
    esp_ldo_channel_config_t power={.chan_id=3,.voltage_mv=2500};ESP_ERROR_CHECK(esp_ldo_acquire_channel(&power,&mipi_power));
    /* 引脚与电压来自 CB V1.2 商家 MIPI 例程，不套用 AI Thinker 的引脚。 */
    esp_video_init_csi_config_t csi={.sccb_config={.init_sccb=true,.i2c_config={.port=0,.scl_pin=29,.sda_pin=28},.freq=100000},.reset_pin=-1,.pwdn_pin=-1};
    esp_video_init_config_t video={.csi=&csi};
    esp_err_t err=esp_video_init(&video);
    if(err!=ESP_OK){ESP_LOGE(TAG,"OV5647 init failed: %s; check CSI ribbon and power",esp_err_to_name(err));vTaskDelete(NULL);return;}
    int fd=open("/dev/video0",O_RDONLY);assert(fd>=0);
    struct v4l2_format fmt={.type=V4L2_BUF_TYPE_VIDEO_CAPTURE};assert(ioctl(fd,VIDIOC_G_FMT,&fmt)==0);
    fmt.fmt.pix.pixelformat=V4L2_PIX_FMT_YUV420;assert(ioctl(fd,VIDIOC_S_FMT,&fmt)==0);
    assert(ioctl(fd,VIDIOC_G_FMT,&fmt)==0);
    unsigned width=fmt.fmt.pix.width,height=fmt.fmt.pix.height;
    ESP_LOGI(TAG,"OV5647 native=%ux%u YUV420 -> HARDWARE H264",width,height);
    struct v4l2_requestbuffers request={.count=3,.type=V4L2_BUF_TYPE_VIDEO_CAPTURE,.memory=V4L2_MEMORY_MMAP};assert(ioctl(fd,VIDIOC_REQBUFS,&request)==0);
    void *buffers[3]={0};assert(request.count<=3&&request.count>=2);
    for(unsigned i=0;i<request.count;i++){
        struct v4l2_buffer b={.type=V4L2_BUF_TYPE_VIDEO_CAPTURE,.memory=V4L2_MEMORY_MMAP,.index=i};assert(ioctl(fd,VIDIOC_QUERYBUF,&b)==0);
        buffers[i]=mmap(NULL,b.length,PROT_READ|PROT_WRITE,MAP_SHARED,fd,b.m.offset);assert(buffers[i]!=NULL);assert(ioctl(fd,VIDIOC_QBUF,&b)==0);
    }
    int type=V4L2_BUF_TYPE_VIDEO_CAPTURE;assert(ioctl(fd,VIDIOC_STREAMON,&type)==0);
    esp_h264_enc_handle_t encoder=NULL;
    esp_h264_enc_cfg_hw_t config={.pic_type=ESP_H264_RAW_FMT_O_UYY_E_VYY,.gop=15,.fps=32,
        .res={.width=width,.height=height},.rc={.bitrate=1200000,.qp_min=24,.qp_max=38}};
    assert(esp_h264_enc_hw_new(&config,&encoder)==ESP_H264_ERR_OK);
    assert(esp_h264_enc_open(encoder)==ESP_H264_ERR_OK);
    uint32_t out_size=512*1024;
    uint8_t *encoded=esp_h264_aligned_calloc(64,1,out_size,&out_size,ESP_H264_MEM_SPIRAM);assert(encoded);
    uint32_t stat_at=(uint32_t)(esp_timer_get_time()/1000),count=0,delivered=0;
    uint64_t encode_us=0,link_us=0,bytes=0;
    for(;;){
        struct v4l2_buffer b={.type=V4L2_BUF_TYPE_VIDEO_CAPTURE,.memory=V4L2_MEMORY_MMAP};
        if(ioctl(fd,VIDIOC_DQBUF,&b)!=0){vTaskDelay(pdMS_TO_TICKS(10));continue;}
        demo_network_state_t net=demo_network_state();
        uint32_t now=(uint32_t)(esp_timer_get_time()/1000);
        if(net.online&&demo_camera_enabled(0)&&demo_frame_ready()){
            esp_h264_enc_in_frame_t input={.raw_data={.buffer=buffers[b.index],.len=width*height*3/2},.pts=now};
            esp_h264_enc_out_frame_t output={.raw_data={.buffer=encoded,.len=out_size}};
            int64_t t0=esp_timer_get_time();
            esp_h264_err_t result=esp_h264_enc_process(encoder,&input,&output);
            encode_us+=esp_timer_get_time()-t0;
            if(result==ESP_H264_ERR_OK){
                count++;bytes+=output.length;t0=esp_timer_get_time();
                delivered+=demo_publish_h264(encoded,output.length,width,height,output.frame_type==ESP_H264_FRAME_TYPE_IDR,now);
                link_us+=esp_timer_get_time()-t0;
            }else ESP_LOGW(TAG,"H264 error=%d",result);
        }else if(!demo_camera_enabled(0))demo_network_upload_idle(net.generation);
        assert(ioctl(fd,VIDIOC_QBUF,&b)==0);
        if(now-stat_at>=2000){
            ESP_LOGI(TAG,"HD encoded_fps=%.2f queued_fps=%.2f encode=%.2fms enqueue=%.2fms bitrate=%.0f RSSI=%d route=%s",
                count*1000.0/(now-stat_at),delivered*1000.0/(now-stat_at),
                count?encode_us/1000.0/count:0,count?link_us/1000.0/count:0,
                bytes*8000.0/(now-stat_at),net.rssi,net.relay?"relay":"direct");
            stat_at=now;count=delivered=0;encode_us=link_us=bytes=0;
        }
    }
}
void app_main(void){
    demo_network_start(false);
    esp_hosted_coprocessor_fwver_t version={0};
    esp_err_t version_result=esp_hosted_get_coprocessor_fwversion(&version);
    ESP_LOGI(TAG,"C6 firmware=%lu.%lu.%lu host=2.2.3 result=%s",(unsigned long)version.major1,
        (unsigned long)version.minor1,(unsigned long)version.patch1,esp_err_to_name(version_result));
    frame_link_start();
    wireless_control_start();
    xTaskCreatePinnedToCore(camera,"ov5647-h264",8192,NULL,4,NULL,1);
    xTaskCreate(control,"serial-control",4096,NULL,2,NULL);
}
