#pragma once
#include <stdbool.h>
#include <stdint.h>

/* Pure policy, also exercised by the host regression test. Times are uint32 ms. */
static inline bool demo_elapsed(uint32_t now,uint32_t then,uint32_t interval){
    return (uint32_t)(now-then)>=interval;
}
static inline bool demo_udp_reopen_due(uint32_t now,uint32_t last_ack,uint32_t last_reopen){
    return demo_elapsed(now,last_ack,800)&&demo_elapsed(now,last_reopen,800);
}
typedef struct {
    bool active,acknowledged;
    uint64_t id;
    uint32_t at;
    unsigned generation;
} demo_relay_ticket_t;
static inline bool demo_relay_accept_ack(demo_relay_ticket_t *ticket,uint64_t id){
    /* Expiring a send credit does NOT invalidate a later receipt. Otherwise
     * valid but slow frames make the network watchdog restart healthy Wi-Fi. */
    if(!ticket->id||ticket->id!=id||ticket->acknowledged)return false;
    ticket->active=false;ticket->acknowledged=true;return true;
}
static inline void demo_relay_release_older(demo_relay_ticket_t *tickets,unsigned count,uint64_t received){
    /* Video is latest-only: confirmed delivery of a newer frame supersedes
     * every older send credit. It does NOT claim the older image arrived. */
    for(unsigned i=0;i<count;i++)if(tickets[i].id<received)tickets[i].active=false;
}
static inline bool demo_transport_stalled(bool relay,unsigned failures,
                                          uint32_t silent_ms,uint32_t connected_ms){
    /* A dropped video frame must not force a healthy Wi-Fi reassociation. */
    return relay ? failures>=6 && silent_ms>=12000 && connected_ms>=15000
                 : failures>=4 && silent_ms>=3000 && connected_ms>=5000;
}
typedef struct {
    uint32_t bytes_per_second,rtt_floor,reduced_at;
    unsigned good,slow;
    bool reduced;
} demo_pacing_t;
static inline void demo_pacing_init(demo_pacing_t *p){
    *p=(demo_pacing_t){.bytes_per_second=60000,.rtt_floor=0,.reduced_at=0,.good=0,.slow=0,.reduced=false};
}
static inline void demo_pacing_feedback(demo_pacing_t *p,bool ok,uint32_t duration_ms,uint32_t now){
    if(ok&&(!p->rtt_floor||duration_ms<p->rtt_floor))p->rtt_floor=duration_ms;
    bool delayed=ok&&duration_ms>300&&duration_ms>p->rtt_floor+180;
    p->slow=delayed?p->slow+1:0;
    bool congested=!ok||p->slow>=3;
    if(congested){
        /* A burst of expired credits is ONE congestion event. Penalizing each
         * ACK independently trapped the previous sender at its minimum rate. */
        if(!p->reduced||demo_elapsed(now,p->reduced_at,500)){
            p->bytes_per_second=p->bytes_per_second*4/5;
            if(p->bytes_per_second<24000)p->bytes_per_second=24000;
            p->reduced=true;p->reduced_at=now;
        }
        p->good=0;
        p->slow=0;
    }else if(++p->good>=12){
        p->bytes_per_second+=2000;
        if(p->bytes_per_second>96000)p->bytes_per_second=96000;
        p->good=0;
    }
}
static inline uint32_t demo_pacing_interval(const demo_pacing_t *p,unsigned bytes){
    uint32_t interval=(uint32_t)(((uint64_t)bytes*1000+p->bytes_per_second-1)/p->bytes_per_second);
    if(interval<80)interval=80; /* Leave air time for both hops and ACKs. */
    if(interval>1000)interval=1000;
    return interval;
}
