#pragma once
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

typedef struct {uint64_t id;unsigned op,value;} demo_control_command_t;
static inline bool demo_control_recent(uint32_t now,uint32_t issued_at,uint32_t issued,uint32_t echoed){
    return issued_at&&issued==echoed&&(uint32_t)(now-issued_at)<2000;
}
static inline bool demo_control_newer(bool have_command,uint32_t echoed,uint32_t last_command){
    return !have_command||(int32_t)(echoed-last_command)>0;
}
/* Fixed 51-byte ASCII datagram. Match this boot and poll sequence before
 * accepting any command, including delayed replies after a route change. */
static inline bool demo_control_reply(const char *data,size_t length,const char *boot,
                                     uint32_t sequence,demo_control_command_t *command){
    char prefix[40];
    int n=snprintf(prefix,sizeof(prefix),"ECS1 %s %08lx ",boot,(unsigned long)sequence);
    if(n!=31||length!=51||memcmp(data,prefix,31)||data[47]!=' '||data[49]!=' ')return false;
    uint64_t id=0;
    for(unsigned i=31;i<47;i++){
        unsigned digit=(unsigned char)data[i];
        if(digit>='0'&&digit<='9')digit-='0';
        else if(digit>='a'&&digit<='f')digit=digit-'a'+10;
        else return false;
        id=(id<<4)|digit;
    }
    unsigned op=(unsigned char)data[48]-'0',value=(unsigned char)data[50]-'0';
    if(op>2||(op==0&&(id||value))||(op!=0&&!id)||
       (op==1&&value>2)||(op>=2&&value>1))return false;
    *command=(demo_control_command_t){.id=id,.op=op,.value=value};return true;
}
