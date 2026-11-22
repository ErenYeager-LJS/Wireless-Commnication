#include <assert.h>
#include <stdio.h>
#include "../integrations/esp-firmware/common/wifi_profiles.h"

int main(void) {
    demo_wifi_profiles_t saved={.version=1};
    assert(demo_profiles_valid(&saved));
    demo_wifi_profile_t p={.ssid="场馆热点",.password="show-password"};
    assert(demo_profile_valid(&p));demo_profiles_promote(&saved,&p);
    assert(saved.count==1 && !strcmp(saved.items[0].ssid,p.ssid));
    /* Changing a known password must not create duplicate profiles. */
    strcpy(p.password,"updated-password");demo_profiles_promote(&saved,&p);
    assert(saved.count==1 && !strcmp(saved.items[0].password,"updated-password"));
    for(unsigned i=0;i<7;i++){
        snprintf(p.ssid,sizeof(p.ssid),"Venue-%u",i);demo_profiles_promote(&saved,&p);
    }
    assert(saved.count==6 && !strcmp(saved.items[0].ssid,"Venue-6") && !strcmp(saved.items[5].ssid,"Venue-1"));
    assert(demo_profiles_valid(&saved));
    demo_wifi_profiles_t reboot=saved;assert(demo_profiles_valid(&reboot));
    /* Exact byte limits, including 32-byte (non-NUL-terminated in IDF) SSIDs. */
    memset(p.ssid,'x',32);p.ssid[32]=0;assert(demo_profile_valid(&p));
    memset(p.ssid,'x',33);assert(!demo_profile_valid(&p));
    strcpy(p.ssid,"Wi-Fi");p.password[0]=0;assert(demo_profile_valid(&p));
    strcpy(p.password,"short");assert(!demo_profile_valid(&p));
    memset(p.password,'a',64);p.password[64]=0;assert(demo_profile_valid(&p));
    p.password[60]='z';assert(!demo_profile_valid(&p));
    memset(p.password,'a',65);assert(!demo_profile_valid(&p));
    saved.count=7;assert(!demo_profiles_valid(&saved));saved=reboot;
    saved.version=2;assert(!demo_profiles_valid(&saved));saved=reboot;
    saved.items[1]=saved.items[0];assert(!demo_profiles_valid(&saved));
    puts("Wi-Fi profile policy: validation, priority, replacement, capacity and reboot blob passed");
}
