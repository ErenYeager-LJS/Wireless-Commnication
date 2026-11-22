#pragma once
#include <stdio.h>
#include <string.h>
#include "mbedtls/md.h"
#include "cloud_config.h"

/* Fixed signed envelope: 51-byte ECP1/ECA1/ECS1 | device ID | HMAC-SHA256.
 * Sequence freshness and command ID checks remain in control_protocol.h. */
static inline int cloud_seal(char *packet,size_t capacity){
    unsigned char key[32],digest[32];
    for(unsigned i=0;i<32;i++){unsigned b=0;if(sscanf(CLOUD_CONTROL_KEY+i*2,"%2x",&b)!=1)return -1;key[i]=b;}
    size_t used=strlen(packet);
    int n=snprintf(packet+used,capacity-used,"|%s",CLOUD_DEVICE_ID);
    if(n<0||used+(size_t)n+66>capacity)return -1;
    used+=n;
    if(mbedtls_md_hmac(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256),key,sizeof(key),(unsigned char*)packet,used,digest))return -1;
    packet[used++]='|';
    for(unsigned i=0;i<32;i++)snprintf(packet+used+i*2,3,"%02x",digest[i]);
    return used+64;
}
static inline bool cloud_unseal(char *packet,int length){
    if(length<51||length>=180)return false;
    char expected[180];memcpy(expected,packet,51);expected[51]=0;
    int n=cloud_seal(expected,sizeof(expected));if(n!=length)return false;
    unsigned diff=0;for(int i=0;i<n;i++)diff|=(unsigned char)expected[i]^(unsigned char)packet[i];
    if(diff)return false;
    packet[51]=0;return true;
}
